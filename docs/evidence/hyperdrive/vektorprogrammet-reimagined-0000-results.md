# Recorded run through Cloudflare Hyperdrive: vektorprogrammet-reimagined, slice 0000

This is a **recorded run of another project**, not a probe of this repository. The catalogue's `hyperdrive-probe` cells rest on it until this repository's own probe Worker has run (`docs/wizard/hyperdrive-probe.md`).

| | |
| --- | --- |
| Source | [`docs/specs/0000-results.md`](https://github.com/phibkro/vektorprogrammet-reimagined/blob/1104c3019a76c619c4c8e9ee04c71ce191467ed4/docs/specs/0000-results.md) of `phibkro/vektorprogrammet-reimagined` (public), commit `1104c3019a76c619c4c8e9ee04c71ce191467ed4` |
| What ran | a Worker deployed on Cloudflare, whose only database address was a Hyperdrive binding with caching disabled, in front of a Neon branch (PostgreSQL 18.6); client `@effect/sql-pg` 4.0.5 and Drizzle `effect-postgres`; 2026-10-16, 07:18 to 07:39 UTC |
| Worker compatibility | date `2026-10-01`, flags `nodejs_compat`, `enable_request_signal` |
| Excerpted | the final run's check lines and the comparison table of check 3b, copied without change; Worker, Hyperdrive and Neon identifiers are left out |
| Not verified here | that the Worker, the Hyperdrive configuration and the run happened as the source says. This file is the source's own account of its run |

## The final run (12 of 12 checks passed, exit code 0)

```text
PASS  1   connect and select 1 through PgClient and Drizzle effect-postgres
PASS  2   a transaction that commits
          the transaction returned; a later request reads ["commit"]
PASS  3a  rollback on a typed failure
          failed with SpikeRollback; a later request reads []
PASS  3b  rollback on interruption (the request is aborted mid-transaction)
          the aborted transaction's key was free after 197 ms and a later request reads []
PASS  4   nested savepoint: inner failure, outer commit
          inner failed with SpikeRollback; a later request reads ["outer"]
PASS  5   INSERT ... ON CONFLICT ... RETURNING
          DO NOTHING returned id 131, then no row; DO UPDATE returned id 133, then id 133
PASS  6   unique violation classified by classifySqlFailure
          the duplicate insert failed as AlreadyExists(Semester, "VAR 274096838")
PASS  7   timestamptz, date, jsonb and numeric round trips
PASS  8   20 concurrent ON CONFLICT upserts on one key
          20 concurrent upserts all returned the row 137; 1 row for the key
PASS  11  Hyperdrive cache is off: a write is read back at once
          10 writes, each read back at once with the same query text in the same and in a later request: every read returned the value just written
```

(Checks 9 and 10 of the source, an HTML sanitiser and a password hash, say nothing about the database and are left out.)

## Check 3b: the same check, with and without `enable_request_signal`

The failing run, with the production flags as they were (`nodejs_compat` only), exit code 1:

```text
FAIL  3b  rollback on interruption (the request is aborted mid-transaction)
          the aborted transaction COMMITTED: its key was taken after 20084 ms (rows ["abort"])
```

Six runs of check 3b on four script versions. The `abort` column is the platform's own record of the aborted request (Workers Logs).

| Run (UTC) | Script version | `enable_request_signal` | Platform outcome of the aborted request | Aborted request lived | Check 3b says |
| --- | --- | --- | --- | --- | --- |
| 07:18:27 | `b6f7d66b` | no | `canceled` | 20 135 ms | FAIL: committed, key taken after 20 064 ms |
| 07:21:38 | `b6f7d66b` | no | `canceled` | 20 121 ms | FAIL: committed, key taken after 20 093 ms |
| 07:23:28 | `163aed3e` | yes | `canceled` | 122 ms | PASS: key free after 265 ms, no row |
| 07:27:26 | `ba32d0c6` | no | `canceled` | 20 151 ms | FAIL: committed, key taken after 20 084 ms |
| 07:29:06 | `0eaeb2b6` | yes | `canceled` | 127 ms | PASS: key free after 233 ms, no row |
| 07:38:53 | `0eaeb2b6` | yes | `canceled` | 160 ms | PASS: key free after 197 ms, no row |

Reading (the source's): the platform noticed the client leaving in all six runs. Without the flag the Worker was not told: `request.signal` never aborted, the fiber slept out its 20 s hold and committed. With the flag the signal aborted, the fiber was interrupted, the client rolled the transaction back through Hyperdrive, and the lock the aborted transaction held was free after about 0.2 s.

## What the catalogue takes from it

| Catalogue row | Cell | From |
| --- | --- | --- |
| `request-abort` | Hyperdrive `breaks` | check 3b: three runs without the flag committed 20 s later; three with it rolled back |
| `savepoints` | Hyperdrive `works` | check 4 |
| `on-conflict` | Hyperdrive `works` | checks 5 and 8 |
| `sqlstate-passthrough` | Hyperdrive `works` | check 6 (the SQLSTATE of a unique violation reached the classifier) |
