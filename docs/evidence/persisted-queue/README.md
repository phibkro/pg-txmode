# Effect 4.1.0 `PersistedQueue` (SQL store) behind PgBouncer: evidence

Spec: [0005](../../specs/0005-persistedqueue-probe.md). Date: 2026-10-29. Question: does the SQL store of Effect's `PersistedQueue` hold at-least-once delivery, one live holder per row, a fence against a stale worker, and recovery after a crash, through PostgreSQL directly and behind PgBouncer in transaction mode? The answer feeds the decision "use `PersistedQueue`, or build the narrow client-neutral core" (research: `/srv/share/projects/reebeat-intent-sources/pg-outbox-research.md` §6, stage 0 (b)).

## What ran

| Part | Version and setting |
| --- | --- |
| Queue | `effect` 4.1.0, `PersistedQueue.layerStoreSql`, `effect/persistence` (`@stability unstable`) |
| Client | `@effect/sql-pg` 4.1.0 (a native PostgreSQL protocol client in 4.1.0, not `pg`: `src/PgConnection.ts`), `prepare` on by default |
| Server | PostgreSQL 18.6; PgBouncer 1.25.2 in transaction mode, Neon's settings (`neonProfile`) with `default_pool_size` 3 |
| Targets | `direct` (control); `pgb1000` (`max_prepared_statements` 1000); `pgb0` (0); `pgb0noprep` (0 and `prepare: false`); `pgb0pool1` (0 and a pool of one server connection) |
| Harness | `startPostgres`, `startPgBouncer`, `neonProfile` of `@pg-txmode/harness`, imported by path |
| Scripts | [`probe.ts.txt`](probe.ts.txt), [`child.ts.txt`](child.ts.txt): scratch files outside the repository (Effect may enter it only through the Effect adapter package, spec 0003), kept here as text |
| Raw output | [`results.txt`](results.txt) (versions, `headroom.sh`, the JSON of every scenario), [`controls.txt`](controls.txt) (three negative controls) |
| Command | `devenv shell -- bun /tmp/pgtx0005/probe.ts offer takers twostores stale crash prepare stress m2b` (in a directory with `effect@4.1.0` and `@effect/sql-pg@4.1.0` installed by `bun install`). Control C3 is `LOCK_SECONDS=3600 bun probe.ts crash`; C1 and C2 run the same script against a copy of `node_modules/effect/dist/persistence/PersistedQueue.js` with one line changed. |
| Script version | `results.txt` came from the script **before** the `LOCK_SECONDS` option was added to `crash` (a parameter whose default, 2, is what ran); the file kept here is the later one, which produced C3. The `crash` rows of `results.txt` therefore were not rerun with the kept file. |

Not run: **Hyperdrive** (no probe Worker has run; `docs/wizard/hyperdrive-probe.md`), Supavisor, Cloudflare Workers, an isolation level other than read committed, anything with `multiplex` on, cleanup (`layerCleanup`), `delay` offers.

## Results

Every row is one observation from `results.txt`; "1 run" means the scenario ran once in the final run (earlier trial runs of the same scenarios gave the same results).

| # | Scenario (script name) | Direct | Behind PgBouncer (`pgb1000`) |
| --- | --- | --- | --- |
| 1 | `offer` inside `sql.withTransaction` that rolls back leaves no queue row and no business row; a committed one leaves one; **an offer outside any transaction commits alone (2 rows)**; the same id offered twice stores one row | 0 / 1 / 2 / 1 | 0 / 1 / 2 / 1 |
| 2 | `takers`: 4 concurrent `take` loops, 40 items, 10 rounds; every item taken once and completed | 10 of 10 rounds | 10 of 10 rounds |
| 3 | `twostores`: two store instances (own pools and pollers) on one queue, 2 takers each, 40 items, 10 rounds | 10 of 10 rounds | 10 of 10 rounds |
| 4 | `stale`, B completes: A stalls past the lease, B takes the row and completes, A then finishes. 3 rounds | log `A-start, B-done(attempts 2), A-done`; row `completed`, attempts 2 | same |
| 5 | `stale`, B fails: as 4, but B fails the row back. 3 rounds | A's late success changes nothing: row `pending`, attempts 2, unclaimed; log `A-start, A-done` | same |
| 6 | `crash`: a child process takes the row and is killed with SIGKILL; the parent takes after the lease (2 s) | taken again 2010 ms after the kill, attempts 2, then `completed` | 2020 ms, attempts 2, `completed` |
| 7 | `stress`: 4 takers and 4 concurrent offerers, 200 items | 200 taken, 200 distinct, 200 completed | same, also on `pgb0`, `pgb0noprep`, `pgb0pool1` |
| 8 | `prepare`: 1 taker, 20 items | 20 of 20 | 20 of 20 on `pgb1000`, `pgb0`, `pgb0noprep`, `pgb0pool1` |
| 9 | `m2b`: 8 fibers, SQL text of its own per fiber, 150 round trips each: wrong answers and errors | 0 and 0 (8 server backends) | 0 and 0 on `pgb1000` (3 backends), `pgb0` (3), `pgb0noprep` (3), `pgb0pool1` (1) |

Negative controls ([`controls.txt`](controls.txt)), each a defect the check must see:

| Control | Defect | Observed |
| --- | --- | --- |
| C1 | the lease condition of the poll removed (`AND true` for `AND (acquired_at IS NULL OR acquired_at < …)`, in a copy of the installed `dist`) | `takers` and `twostores`: `everyRoundTakenExactlyOnce: false` on direct and behind PgBouncer (rows are claimed again while held) |
| C2 | the fence removed from `complete()` (`AND true` for `AND acquired_by = lock`) | `stale`, B fails: A's late success marks the row `completed` (without the defect: `pending`) |
| C3 | the lease never lapses (`LOCK_SECONDS=3600`) | `crash`: nothing is taken before the probe's 2 minute limit (with a 2 s lease: 2.0 s) |

## What the SQL store does, from the source (`effect@4.1.0`, `src/persistence/PersistedQueue.ts`)

- **Claim** (`poll`, lines 1745 to 1766): one statement, `WITH cte AS (UPDATE … WHERE sequence IN (SELECT … AND state = 'pending' AND attempts < max AND visible_at <= NOW() AND (acquired_at IS NULL OR acquired_at < NOW() - lease) ORDER BY visible_at, sequence FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …)`. `SKIP LOCKED` is `unverified` on Hyperdrive (catalogue row `skip-locked`). The lease is `lockExpiration` (default 2 minutes); a refresh fibre renews the leases of the rows this store holds every `lockRefreshInterval` (30 s, lines 1618 to 1635, 1690 to 1700).
- **Fence** (`complete`, `fail`, `retry`, `interrupt`, lines 1645 to 1688): every settlement has `WHERE sequence = … AND acquired_by = <the poll's lock>`. A stale lock matches nothing; the error channel is not told (`ack`, lines 1636 to 1644, retries the statement and dies only if it errors).
- **Offer** (lines 1550 to 1556, 1924 to 1948): `INSERT … ON CONFLICT (id, queue_name) DO NOTHING`, on the ambient `SqlClient`, so it joins an open `sql.withTransaction` and also runs without one. It wakes takers with `sql.afterCommit`.
- **Failure record**: `last_failure = Cause.pretty(cause)` (lines 1659 to 1673): the whole cause text, not a class from a closed set. A row ends `failed` when `attempts >= maxAttempts`, whatever the cause (lines 1727 to 1743, 2003 to 2005), or at once when the payload does not decode.
- **Time**: database clock (`NOW()`), delays rounded up to whole seconds (docs, line 1471).
- **Migration** (`sql/Migrator.ts:250`): `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` inside a transaction. No `LISTEN`, no advisory lock anywhere in the store.
- **Prepared statements**: `@effect/sql-pg` 4.1.0 names statements `effect_<random per cache>_<n>` (`PgConnection.ts` `PreparedCache`), so two clients cannot share a name, and it prepares transaction control (`prepareTransactionControls: true`, `PgClient.ts:319`).

## Reading against the research's requirements (`pg-outbox-research.md` §2.1 and §2.2b)

| Requirement | `PersistedQueue` SQL store, measured here |
| --- | --- |
| R1 write in the business transaction | **Joins an open transaction** (1). It also commits alone outside one, so it cannot stop the dual-write mistake: the transaction is not required in the type. |
| R2 / LS1 one live holder | **Holds** across one store and across two stores (2, 3); C1 shows the check can see a double claim. No claim by id, so no typed `Held` / `Settled` answer. |
| R3 / LS2 stale consumer fenced | **Fenced, silently** (4, 5; C2). The stale worker's handler ran to the end (`A-done` logged) and nothing in the probe's output shows it being told; the probe did not record A's `take` result itself (the research's T3b did: success). |
| R4 / LS3 at least once, a crash does not lose | **Holds** with a real SIGKILL (6; C3). A stalled handler runs twice (4): effects must be idempotent. |
| R5 / LS4 ack in the caller's transaction | **Not offered**: settlement is its own statement after the handler (`complete` is run by the `take` finalizer). |
| R7 / LS5 error class, `dead` only after a class | **Not offered**: `failed` after `maxAttempts` regardless of cause; `last_failure` holds `Cause.pretty` text (it can hold payload or provider text). |
| R8 wake without `LISTEN` | Polls (default 1 s) and an in-process nudge after commit; needs a long-lived fibre per queue (and a refresh fibre). Not examined on a Worker. |
| Pooler fit | No session feature. Behind PgBouncer with `max_prepared_statements` 1000 and 0 (with and without `prepare`), a pool of one or three server connections: no error and no wrong answer in 1200 statements per target (9). **Why it does not break at 0 is not explained**: statements were issued on 3 different server backends and named statements were in use by default; the M2b hang of the research (with an earlier `@effect/sql-pg`) did not appear. That is an observation, not a guarantee. |
| Hyperdrive | **Not run.** The claim uses `SKIP LOCKED` (`unverified`); the migrator `LOCK TABLE`; reads are not part of the claim (an `UPDATE`), so Hyperdrive's read cache does not apply to it. |
| Other | `@stability unstable`; Effect only (no client-neutral surface); no renewal of a lease the *caller* wants longer than `lockExpiration` except the store's own refresh. |

## Verdict, for the decision

Measured: behind PgBouncer the SQL store is a sound at-least-once queue with one live holder per row, a fence against a stale worker, and recovery after a crash. It is missing, by construction, what the narrow core exists to provide: a transaction required at `offer` (R1 as a type), a **reported** lost claim (LS2), settlement in the caller's transaction (LS4), and a recorded error class with `dead` only after one (LS5). Whether those four gaps decide it is the operator's call (the research's decision 1: C or A2 / upstream). Not measured, and needed before relying on either through Hyperdrive: the deployed probe.
