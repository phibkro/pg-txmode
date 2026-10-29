# 0004 The outbox delivers at least once: lease, token and fence

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's stage-0 decision (a) of the pg-outbox research, "fix `outbox.relay` in pg-txmode with a crash test" (`/srv/share/projects/reebeat-intent-sources/pg-outbox-research.md`, "A defect in the existing pg-txmode pattern", §1; requirements R2, R3, R7, LS1 to LS3).
Process: [spec 0000](0000-development-lifecycle.md). Based on `main`. Numbered 0004 by agreement with the author of spec 0003 (the Effect adapter), which is built in parallel.
Verify skill: `verify-pg-txmode` (path table rows `packages/core/**` and `packages/harness/**`).

## Problem

`outbox.statements.relay` of spec 0001 was

```sql
UPDATE outbox SET published_at = now() WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL
  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING id, topic, payload
```

It marks a message published **when it claims it**. A relay that commits this statement and crashes before it sends loses the message: at most once, not at least once. It is correct only if the relay keeps its transaction open while it sends, which the catalogue's own row `A transaction that stays open` calls degrading, and which holds a server connection (and its row locks) for as long as the broker takes. The tests of spec 0001 ("40 messages by 2 relays", "a second relay skips locked rows") never crash a relay between claim and send. The same defect sits in the "Write the change and the message in one transaction" construct that the README advertises.

## Goal

The outbox construct is two patterns that the library tests behind PgBouncer:

- `outbox` (unchanged in meaning): write the change and its message in one transaction.
- `outboxDelivery`: five autocommit statements, no transaction kept open while a message is sent.

```text
claimBatch(limit, leaseMs) | claimById(id, leaseMs)   → rows with a new claim_token; attempts + 1; status stays 'pending'
   … the worker sends (idempotency key: the row id; attempts is the fencing number) …
ack(id, token) | release(id, token, delayMs, errorClass) | bury(id, token, errorClass)
        each:  WHERE id = $1 AND claim_token = $2 AND status = 'pending'  → one row, or none ("claim lost")
```

## Journey

1. A command writes its rows and `insertMessage` in one transaction (unchanged).
2. A relay claims: `claimBatch` (uses `FOR UPDATE SKIP LOCKED`, which is `unverified` on Hyperdrive) or **`claimById`** (one conditional `UPDATE`, no `SKIP LOCKED`: the Hyperdrive-safe claim; the id comes from a wake-up or a poll). It gets `id, topic, payload, claim_token, attempts`, or no row.
3. It sends. If it dies here, the row is still `pending` with a lease; once `claimed_until` has passed, any relay claims it again (`attempts` 2).
4. It calls `ack` (delivered), `release` (not delivered; `next_attempt_at` moves, `last_error` records a class) or `bury` (ends the row as `dead`; the class is required). An empty result means the lease was lost and the row now belongs to someone else: do nothing more.

## Constraints and values

- **No transaction while sending.** Every delivery statement is one autocommit statement.
- **Fence by token.** Ack, release and bury match `claim_token` and `status = 'pending'`. A stale token changes nothing and the caller sees zero rows. A lapsed lease that nobody has taken over does not stale the token: the answer is still true.
- **A row ends only after a recorded class.** `status = 'dead'` requires `last_error` (a CHECK); `bury` with a null class fails with 23514 and the row stays pending.
- **The server's clock.** `now()` of the database decides the lease and the retry date, so relays with different clocks agree. A test can have a lapsed lease at once by claiming with `leaseMs = 0`.
- **Unordered, at least once.** No order across rows; a message can be sent twice (a crash after the send, before the ack).
- Nothing here needs a session: no `LISTEN`, no advisory lock, no named statement.
- **Not in scope**: ack in the caller's own transaction (R5), a lock held to the end of the transaction that fences a stale worker's database writes (`holdClaim`), receipts and a stale-row sweep, a wake-up transport, retention, attempt policy (the caller decides when to `bury`), the pg-outbox library itself. Each is in the research's stage 1.

## What is built

| Part | Content |
| --- | --- |
| Schema | `exampleSchema`: `outbox` gains `status`, `attempts`, `claim_token`, `claimed_until`, `next_attempt_at`, `delivered_at`, `last_error` and four CHECKs (token and lease together; `dead` needs a class; `delivered` iff `delivered_at`; status values) |
| Patterns | `packages/core/src/patterns.ts`: `outbox` loses `relay`; new `outboxDelivery` with `claimBatch`, `claimById`, `ack`, `release`, `bury` and the protocol in its header |
| Catalogue | new row `outbox-lease` (direct `docs`, PgBouncer `pgbouncer-probe`, Hyperdrive `unverified`); the README table is regenerated; `skip-locked` is now the row of `claimBatch` (and of `claimJob`) |
| Probe | `pattern-outbox-lease` in `patternProbes.ts`: crash then reclaim, stale ack, 20 concurrent claims by id, on PostgreSQL and on PgBouncer; its observation must equal the catalogue cells |
| Tests | `packages/harness/test/patterns.test.ts`: disjoint relays, a relay in an open transaction skipped, crash between claim and send (real 300 ms lease), the at-most-once control, stale ack, release, bury, claim by id |
| Lint | the library's own patterns run through the lint test in every mode (no error): the new pattern is in `patterns` |

## Falsifiers

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
| --- | --- | --- | --- |
| H1 | A relay that claims and never acks does not lose the message: it is claimed again after the lease, attempts 2; while the lease is live nobody else gets it | `patterns.test.ts` (crash), probe `pattern-outbox-lease` | mark the row delivered in the claim (the old relay); the test "control: the at-most-once relay" shows what that loses |
| H2 | After the lease lapsed and a second relay claimed, the first relay's ack, release and bury change nothing; the second's ack delivers once and a repeat changes nothing | `patterns.test.ts` (stale), probe | drop `claim_token = $2::uuid` from `ack` |
| H3 | Concurrent relays claim disjoint sets that add up to every message; a relay that holds its rows in an open transaction is skipped by a second relay, which takes the next rows instead of waiting | `patterns.test.ts` | remove only ` SKIP LOCKED` from `claimBatch`; remove the live-lease condition from `claimBatch` |
| H4 | 20 concurrent claims by id of one row give exactly one winner, and the statement contains no `SKIP LOCKED` | `patterns.test.ts`, probe | remove `(claimed_until IS NULL OR claimed_until <= now())` from `claimById` |
| H5 | `release` records the class and the next attempt waits for its date, in both claims; `bury` needs a class and a dead row is never claimed | `patterns.test.ts` | H5a: drop `next_attempt_at <= now()` from `claimById`; H5c: from `claimBatch`; H5b: drop the CHECK on `dead` |
| H6 | The probe's observation equals the catalogue cells; the library's own patterns pass the lint (no error) in every mode | `probes.test.ts`, `analyze.test.ts` | change the `transactionPooled` cell of `outbox-lease` to `leaks` |
| H7 | `bun run ready` exits 0 | `ready` | the controls above |

## Constraints on the implementation

- Free on mechanism: the statements may change as long as the journey and the falsifiers hold.
- Tests wait for the server's own clock where a lease must lapse (300 ms, then polling the claim for up to 5 s); everywhere else a lease of 0 ms stands for "lapsed".

## Risks

| Risk | Mitigation |
| --- | --- |
| Hyperdrive was not tried: its caching of reads must not apply to the outbox, and `claimById` has not run through it | The row is `unverified` for Hyperdrive and says so; the claim by id avoids the one unverified construct |
| `claimById` answers "no row" for held, delivered, dead and not yet due alike | Said in the pattern's header; a typed `Claimed | Held | Settled` answer belongs to a library, not to a SQL string |
| A batch claim orders by `id` only, so a row due long ago can wait behind newer rows that keep arriving | Not an ordering promise; a later spec can order by `next_attempt_at` |
| A worker that outlives its lease can still do its side effects | Said; the fence protects the row, not the world: `attempts` is the fencing number for a system that can check it |

## Open questions for the operator

1. Does `release` need an attempt cap in SQL (end the row after N claims), or is the caller's policy enough? Here the caller decides when to `bury`.

## Revisions

- **2026-10-29, plan written** with the build.
- **2026-10-29, after review round 1 of PR #6 (RevPgTx3 at `b2270c3`; none changes the journey).**
  1. **The retry date of `claimBatch` is tested** (a medium): the release test claimed by id, so dropping `next_attempt_at <= now()` from `claimBatch` passed every test. The test "claimBatch honours the retry date" releases with a one-hour delay and expects no claim until `next_attempt_at` is moved. H5's control now runs on both claims (H5a `claimById`, H5c `claimBatch`).
  2. **Two more tests:** a lapsed lease that nobody took over does not stale its token (the late ack delivers); `drain` is bounded at 50 claims, so a wrong claim that never comes back empty fails in milliseconds (H3b took 60 s before).
  3. **The pattern header says what the tests found:** `release` accepts a null class and then overwrites `last_error` with null (pass one); the fence needs READ COMMITTED (under REPEATABLE READ the loser of a race gets 40001); the `status = 'pending'` conditions of `ack`, `release` and `bury` are defence (every settle clears the token, so they change no result); the example `outbox` table is a fixture, and now has the partial index `outbox_due`, `CHECK (attempts >= 0)` and `created_at`.
  4. **Wiring that said more than it gated:** the probe `pattern-skip-locked` now also runs `claimBatch` (it exercised only the job claim); the test "control: a claim that marks the row delivered" is renamed to say that it is a rewritten statement, and that H1 is the real pin; a core test checks that every `Pattern.rows` entry is a catalogue row (nothing read the field).
- **2026-10-29, after review round 2 of PR #6 (RevPgTx3 at `6399d10`; rebased onto `main` after specs 0003 and 0005 merged; no content change).**
  1. **Correction to round 1, item 1:** the test is not called "claimBatch honours the retry date". It is `release records the error class and %s waits for the next attempt's date`, a `test.each` over `claimById` and `claimBatch` (the two claims share one test body).
  2. The pattern header now says that the fixture's `outbox_due` index and `CHECK (attempts >= 0)` are not exercised by any test.
  3. The README roadmap and `STATE.md` were re-applied by hand on the merged `main` (the README catalogue table is generated and was regenerated, not merged).
