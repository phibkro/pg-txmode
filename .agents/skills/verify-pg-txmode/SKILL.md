---
name: verify-pg-txmode
description: "Run and observe pg-txmode the way a user does: check the machine's headroom, run every gate on a clean checkout, and (from spec 0001) run the harness against a throwaway PostgreSQL and PgBouncer. Use when reviewing a pg-txmode PR, when verifying a change, or before a heavy job."
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

`ready` is the sequence of every gate in `AGENTS.md`. It must exit 0 on the head. Keep its output in the run directory.

## 3. Path table

| Changed paths | What to run besides `ready` |
| --- | --- |
| `.agents/**`, `docs/**`, `*.md` only | nothing: these drive no code. Say so in the report |
| `tools/quality/**` | the gate's negative control from `AGENTS.md` ("See it fail") for each gate that the diff touches |

Spec 0001 adds `packages/*` (the catalogue, the harness, the lint) and rows to this table: the harness starts PostgreSQL and PgBouncer on free ports and needs no `devenv up`.

## 4. Cleanup

Remove the detached worktree. The evidence stays.
