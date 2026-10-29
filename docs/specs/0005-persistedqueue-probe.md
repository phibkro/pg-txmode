# 0005 Stage-0 gate: Effect `PersistedQueue` through the harness

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's stage 0 (b) of the pg-outbox research (`/srv/share/projects/reebeat-intent-sources/pg-outbox-research.md` §6): "probe Effect 4.1 `PersistedQueue` (SQL store) through the harness on PgBouncer; record the evidence". This is an investigation PR: its product is evidence and a verdict, not a feature.
Process: [spec 0000](0000-development-lifecycle.md). Based on `main`. Numbered 0005 by agreement with the author of spec 0003.

## Problem

The decision "use Effect's `PersistedQueue` as the outbox, or build a narrow client-neutral core" rests on claims about `PersistedQueue` that the research read from source and ran five times on PostgreSQL 17 and PGlite, never behind a pooler, never in a loop. Nothing in this repository says what the SQL store does behind PgBouncer in transaction mode.

## Goal

One evidence file, [`docs/evidence/persisted-queue/README.md`](../evidence/persisted-queue/README.md), with raw output and the commands, that answers for `effect@4.1.0` and `@effect/sql-pg@4.1.0`, on PostgreSQL 18 directly and behind PgBouncer 1.25 (Neon's settings): does an offer join the caller's transaction, do concurrent takers hold one row each, is a stale ack silent, does a lapsed lease give the row to another worker after a real crash. No change to the library.

## Journey

```sh
git checkout feat/0005-persistedqueue-probe
# the scripts are in docs/evidence/persisted-queue/*.ts.txt; to run them: a directory with `bun add effect@4.1.0 @effect/sql-pg@4.1.0`,
cp docs/evidence/persisted-queue/probe.ts.txt <dir>/probe.ts; cp docs/evidence/persisted-queue/child.ts.txt <dir>/child.ts   # then fix the two paths at the top of probe.ts
devenv shell -- bun <dir>/probe.ts offer takers twostores stale crash prepare stress m2b
```

Read the evidence file's tables and verdict.

## Constraints and values

- **No Effect in the repository's source.** Effect may enter only through the Effect adapter package (spec 0003, the Effect boundary test). The probes therefore live in a scratch directory outside the repository, and the repository keeps them as text (`.ts.txt`) and their raw output (`.txt`): they are evidence, not code that lint, build or test touches.
- **Each claim has a raw output, a command and, where a check could say "yes" for the wrong reason, a negative control** (a defect injected into a copy of the installed `dist`).
- **Primary sources only:** the installed package source (`effect@4.1.0`, `@effect/sql-pg@4.1.0`) with line numbers, and measurements. What was not measured is said.
- **Not claimed:** anything about Hyperdrive, Supavisor, Workers, other isolation levels, `multiplex`, cleanup, delayed offers.

## What is built

| Part | Content |
| --- | --- |
| Evidence | `docs/evidence/persisted-queue/README.md` (results, controls, source reading, verdict), `results.txt` and `controls.txt` (raw), `probe.ts.txt` and `child.ts.txt` (the scripts) |
| Spec | this file |

## Falsifiers

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
| --- | --- | --- | --- |
| K1 | An offer in a transaction that rolls back leaves no row; a committed one leaves one; one outside a transaction commits alone | `results.txt`, scenario `offer` | the outside-a-transaction row is itself the control: the probe sees a write that does not join |
| K2 | Concurrent takers hold one row each: 4 takers x 10 rounds, two stores x 10 rounds, 200 items with concurrent offers; on direct and behind PgBouncer, with `max_prepared_statements` 1000 and 0 | scenarios `takers`, `twostores`, `stress`, `prepare` | C1: the lease condition of the poll removed gives `everyRoundTakenExactlyOnce: false` |
| K3 | A stale worker's late success changes nothing | scenario `stale` | C2: the fence removed from `complete()` ends the row `completed` |
| K4 | After a SIGKILL of the worker, the row is taken again after the lease with attempts 2 | scenario `crash` | C3: a lease that never lapses takes nothing |
| K5 | The M2b class (wrong answers, errors) is looked for with 8 fibers on a pool of 3 server connections and of 1, at `max_prepared_statements` 0 | scenario `m2b` | none on this client; the harness pins the class for node-postgres (spec 0001, F11), which is the control that the shape of workload can see it |
| K6 | Every number in the report is in `results.txt` or `controls.txt` | read | n/a |
| K7 | `bun run ready` exits 0 (the PR adds no source) | `ready` | n/a |

## Constraints on the implementation

- Free on mechanism. The evidence is what is judged.

## Risks

| Risk | Mitigation |
| --- | --- |
| The scratch scripts drift from the file in the repository | The file in the repository is a copy taken after the last run; the evidence README says which run |
| A control proves the check, not the product | Said: C1 to C3 are injected defects in a copy of `dist`, not behaviour of `effect` |
| Single runs of `stale` (3 rounds) and `crash` (1 per target) | Said in the evidence; they show the mechanism, not a rate |
| The verdict is read as an endorsement of one side | It lists what was measured and what the store lacks; the decision stays the operator's |

## Open questions for the operator

1. Does the decision need the same probe through Hyperdrive before it is taken? It needs the operator's Cloudflare credentials (wizard).

## Revisions

- **2026-10-29, plan written** with the build. Findings while building: `@effect/sql-pg` 4.1.0 is a native protocol client with per-connection statement names, so the M2b scenario of the research (wrong answers and hangs at `max_prepared_statements` 0) did not reproduce and is reported as "not reproduced, not explained"; one store instance has one poller, so the claim race needed a `twostores` scenario to mean anything.
