#!/usr/bin/env bash
# shellcheck disable=SC2016 # the awk programs below are literal on purpose
# Admission control for a heavy job (`bun run ready`, or the harness: PostgreSQL, PgBouncer and the test runner).
# Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8
# (.agents/skills/verify-studio/scripts/headroom.sh), which adapted it from phibkro/vektorprogrammet-reimagined
# @ 1104c3019a76c619c4c8e9ee04c71ce191467ed4 (.agents/skills/verify-vektorprogrammet/scripts/headroom.sh).
# Deviations from studio's: pg-txmode's names; the demand figures below.
#
# Exits 0 only when all four hold (the operator's limits of 2026-10-29):
#   memory    MemAvailable after the job's expected demand is at least 20% of MemTotal
#   swap-in   the pswpin delta over a SAMPLE_SECONDS sample is under 1000 pages per second
#   memory PSI  `full` avg60 is under 10% (avg60, not avg10: a short burst is not a reason to wait)
#   load      the 1-minute load average is under the number of CPU threads
# and the disks that the job writes to keep twice its expected writes free. A sample that cannot be read (file missing,
# field absent, empty, not a number) makes its gate SHORT: an unmeasured limit is not a passed limit.
# Back off your own job if memory PSI `full` avg60 stays above 20%, or swap-in stays above its limit, for a minute.
#
# Usage: scripts/headroom.sh
# Environment: DEMAND_MEM_MIB, DEMAND_DISK_MIB, SAMPLE_SECONDS (10 to 30), and for the test PROC_ROOT (default /proc)
# and HEADROOM_NPROC (default `nproc`).
#
# The demand figures are assumptions, not measurements (no run has been timed yet; fix them here when one is): the
# toolchain run (check, tests, build) about 2 GiB, PostgreSQL and PgBouncer 1 GiB more, evidence well under 100 MiB.
DEMAND_MEM_MIB="${DEMAND_MEM_MIB:-3072}"
DEMAND_DISK_MIB="${DEMAND_DISK_MIB:-512}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-10}"
PROC_ROOT="${PROC_ROOT:-/proc}"

# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mkdir -p "$EVIDENCE_ROOT"

# One value from a kernel file: empty when the file is missing or the field is absent.
sample() { awk "$1" "$PROC_ROOT/$2" 2>/dev/null || true; }
numeric() { [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

swapin0="$(sample '/^pswpin /{print $2}' vmstat)"
sleep "$SAMPLE_SECONDS"
swapin1="$(sample '/^pswpin /{print $2}' vmstat)"

fail=0
check() { # name, ok(0/1), detail
  if [[ "$2" == 0 ]]; then echo "ok    $1: $3"; else echo "SHORT $1: $3"; fail=1; fi
}
# A gate whose sample cannot be read is short: an unmeasured limit is not a passed limit (the donor fails closed too).
unreadable() { check "$1" 1 "sample unreadable or not a number ($2): the limit cannot be checked"; }
# $1 < $2 and $1 >= $2 as shell statuses (0 holds), for awk-computed decimals.
below() { awk -v a="$1" -v b="$2" 'BEGIN{print (a<b)?0:1}'; }
at_least() { awk -v a="$1" -v b="$2" 'BEGIN{print (a>=b)?0:1}'; }

mem_total_kib="$(sample '/^MemTotal:/{print $2}' meminfo)"
mem_avail_kib="$(sample '/^MemAvailable:/{print $2}' meminfo)"
if numeric "$mem_total_kib" && numeric "$mem_avail_kib" && [[ "$mem_total_kib" -gt 0 ]]; then
  mem_after=$(awk -v a="$mem_avail_kib" -v t="$mem_total_kib" -v d="$DEMAND_MEM_MIB" 'BEGIN{printf "%.4f", 100*(a-d*1024)/t}')
  check "memory" "$(at_least "$mem_after" 20)" "MemAvailable $((mem_avail_kib / 1024)) MiB of $((mem_total_kib / 1024)) MiB, ${mem_after}% free after ${DEMAND_MEM_MIB} MiB (need >= 20%)"
else
  unreadable "memory" "MemTotal '${mem_total_kib}', MemAvailable '${mem_avail_kib}' in meminfo"
fi

if numeric "$swapin0" && numeric "$swapin1"; then
  swapin_rate=$(((swapin1 - swapin0) / SAMPLE_SECONDS))
  check "swap-in" "$(below "$swapin_rate" 1000)" "${swapin_rate} pages/s over ${SAMPLE_SECONDS}s (need < 1000)"
else
  unreadable "swap-in" "pswpin '${swapin0}' then '${swapin1}' in vmstat"
fi

psi_full="$(sample '/^full/{split($3,a,"="); print a[2]}' pressure/memory)"
psi_avg10="$(sample '/^full/{split($2,a,"="); print a[2]}' pressure/memory)"
if numeric "$psi_full"; then
  check "memory PSI" "$(below "$psi_full" 10)" "full avg60 ${psi_full}% (need < 10%; avg10 ${psi_avg10}% is reported, not gated)"
else
  unreadable "memory PSI" "full avg60 '${psi_full}' in pressure/memory"
fi

nproc="${HEADROOM_NPROC:-$(nproc)}"
load1="$(sample '{print $1}' loadavg)"
if numeric "$load1" && numeric "$nproc"; then
  check "load" "$(below "$load1" "$nproc")" "1-minute load average ${load1} on ${nproc} threads (need < ${nproc})"
else
  unreadable "load" "load '${load1}', threads '${nproc}'"
fi

for path in "$EVIDENCE_ROOT" "$TREE"; do
  free_mib=$(df --output=avail -BM "$path" | tail -1 | tr -dc '0-9')
  check "disk $path" "$([[ "$free_mib" -ge $((DEMAND_DISK_MIB * 2)) ]] && echo 0 || echo 1)" "${free_mib} MiB free (need >= $((DEMAND_DISK_MIB * 2)) MiB: twice the expected ${DEMAND_DISK_MIB} MiB of writes)"
done

# Reported, not gated.
echo "info  psi memory some: $(awk '/^some/{print $2, $3}' "$PROC_ROOT/pressure/memory" 2>/dev/null)"
for resource in cpu io; do
  [[ -r "$PROC_ROOT/pressure/$resource" ]] && echo "info  psi $resource: $(grep '^some' "$PROC_ROOT/pressure/$resource" | cut -d' ' -f2)"
done

if [[ "$fail" != 0 ]]; then
  echo "headroom is short: wait for a running job to exit, or run a smaller scope (VERIFY_FORCE=1 overrides, and the report must say so)" >&2
  exit 1
fi
