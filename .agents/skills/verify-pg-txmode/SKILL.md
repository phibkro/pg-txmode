---
name: verify-pg-txmode
description: "Run and observe pg-txmode the way a user does: check the machine's headroom, run every gate on a clean checkout, run the probe suite against a throwaway PostgreSQL and PgBouncer, and lint SQL. Use when reviewing a pg-txmode PR, when verifying a change, or before a heavy job."
---

<!-- Provenance: new for pg-txmode, in the shape of reebeat/studio's `verify-studio` @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8
     (launch, doctor, drive, evidence, cleanup), much smaller. The scripts it names are adapted; see PROVENANCE.md. -->

# Verify pg-txmode

A reviewer uses this skill in their own detached worktree (see `review-pr`). The evidence directory is outside every worktree: `~/.local/state/pg-txmode-verify/<UTC date>-<pr or sha>/` (`VERIFY_EVIDENCE_ROOT` overrides it).

## 1. Headroom

```sh
.agents/skills/verify-pg-txmode/scripts/headroom.sh
```

Exit 0 means the operator's four limits hold (memory after the demand, swap-in, memory PSI `full` avg60, load) and the disks have room. On `SHORT`, wait or run a smaller scope; never force a run without saying so in the report.

## 2. The gates

```sh
devenv shell -- bun install --frozen-lockfile
devenv shell -- bun run ready
```

`ready` is the sequence of every gate in `AGENTS.md`, and it includes the harness: the tests start their own PostgreSQL 18 and PgBouncer 1.25 on free ports (no `devenv up`). It must exit 0 on the head. Keep its output in the run directory.

## 3. The probes, as a user sees them

```sh
devenv shell -- bun run probes "$EVIDENCE/probes.txt"
```

One block per probe: `ok` when what was observed on PostgreSQL (the control) and on PgBouncer equals the catalogue's cells for the row that names the probe, `DIFF` when not (exit 1). The raw text is the evidence for every statement in a report about a probe. The catalogue's README table must be the generated one: `devenv shell -- bun run check:docs`.

To see a leak by hand: `devenv shell -- bun run stack` (PostgreSQL on 54320, PgBouncer on 64320, until interrupted), then two `psql` sessions on the pooled port: `SET search_path = pg_catalog` in one, `SHOW search_path` in the other.

## 4. The lint

```sh
devenv shell -- bun packages/lint/src/cli.ts --mode hyperdrive <paths> --log run.ndjson
```

Exit 1 when a finding is an error; `--strict` makes warnings fail too. A log comes from the harness's `recording(connect, write)` wrapper.

## 5. Path table

| Changed paths | What to run besides `ready` |
| --- | --- |
| `.agents/**`, `docs/**`, `*.md` only | nothing: these drive no code. Say so in the report |
| `tools/quality/**` | the gate's negative control from `AGENTS.md` ("See it fail") for each gate that the diff touches |
| `packages/core/src/catalogue*.ts` | section 3 (every probe against the changed row), `check:docs`; check that each new source URL resolves and says what the cell says |
| `packages/core/src/**` (other) | `ready`; a negative control for the changed law (spec 0001 lists them) |
| `packages/harness/**` | sections 2 and 3 |
| `packages/lint/**` | sections 2 and 4 on a file with a known violation (any M1 statement) |
| `packages/pg/**` | section 2, then `cd packages/pg && devenv shell -- bunx vp test` (25 tests against a throwaway PostgreSQL and PgBouncer; the abort tests take a few seconds) |

## 6. Cleanup

Remove the detached worktree. The evidence stays. The harness removes its temporary directories and stops its servers itself; `ps` should show no `postgres` or `pgbouncer` of yours afterwards.
