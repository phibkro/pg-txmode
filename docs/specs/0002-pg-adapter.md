# 0002 The `pg` (node-postgres) adapter

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's assignment of 2026-10-29 ("apply the capability record; refuse session-only APIs; offer a transaction helper with retry and `SET LOCAL` timeouts").
Process: [spec 0000](0000-development-lifecycle.md). Stacked on the branch of PR #3 (spec 0001).
Verify skill: `verify-pg-txmode` (path table row `packages/pg/**`).

## Problem

The core knows what a transaction pooler breaks. A client still has to be built so that the broken thing cannot be reached: node-postgres will happily `LISTEN` on a pooled connection, send a named statement that PgBouncer does not track, hold an advisory lock in a session that belongs to nobody, or finish a transaction after the request that started it is gone. Cloudflare recommends `pg` first for Hyperdrive, and Drizzle (node-postgres), Kysely and Prisma's `adapter-pg` sit on it (report section 7; that they accept a caller-built client is unverified here).

## Goal

`@pg-txmode/pg`: a thin adapter over node-postgres whose behaviour is the capability record of the mode it is given, and nothing of its own.

```ts
const db = createDatabase({ connectionString, mode: pgBouncer(1000) });   // TxClient: mode, capabilities, query, transaction, end
db.listen                                                                  // type error: no such member on a pooled mode
await db.transaction(
  async (tx) => { /* the whole body; runs again after 40001 or 40P01 */ },
  { isolation: "serializable", timeouts: { statementMs: 3000, lockMs: 500 }, signal: request.signal }
);
```

## Journey

```text
createDatabase({ mode, connectionString })     → TxClient; a Direct or SessionPooled mode also has listen and withAdvisoryLock
db.query(sql, values, { name })                → one statement; a named statement only where the mode tracks them
db.transaction(body, options)                  → BEGIN ISOLATION LEVEL ..; SET LOCAL timeouts (one round trip) → body → COMMIT
                                                 retried as a whole after 40001 and 40P01; aborted with the request's signal
db.end()                                       → close the pool (create the database inside the request handler and end it there)
```

## Constraints and values

- **The adapter has no knowledge of poolers of its own.** Every decision reads `capabilities(mode)`: named statements (`preparedStatements`), pipelining (`pipelining`), session-only methods (`SessionApi` and `requireFeature`).
- **Refuse, do not detect.** The mode is declared; the adapter cannot tell a Hyperdrive from a direct endpoint. A wrong declaration is the caller's, and the catalogue's `local-development` row is why the declared mode should be the production one.
- **An unverified behaviour is refused unless the caller accepts it** (`allowUnverified`), as in the core.
- **A transaction does not outlive its request.** On abort the adapter sends a CancelRequest, then `ROLLBACK`, then closes the socket (each step given 2 s); PostgreSQL rolls the transaction back. A call whose signal aborts while it waits for a connection never runs. After `COMMIT` was sent the outcome is unknown and the error says so.
- **The server's FATAL is not lost.** node-postgres reports an idle-in-transaction or transaction timeout only as an `'error'` event (spec 0001, Revisions 5); the adapter keeps the first event and throws it, so the SQLSTATE reaches `failureOf`.
- No Effect, no new dependency beyond `pg` and the core.

## What is built

| Part | Content |
| --- | --- |
| `createDatabase` | `database.ts`: overloads give `TxClient` for a transaction-pooled mode and `TxClient & SessionMethods` for `Direct` and `SessionPooled`; pool of at most 5 (a Worker invocation can hold six outgoing connections) |
| Statement door | `statement.ts`: every statement passes `executorFor(mode)`; a name on a mode that does not track named statements throws `NamedStatementRefusedError` quoting the catalogue row |
| Session methods | `session.ts`: `listen` (with `onError`) and `withAdvisoryLock` (the body gets `lost`), each on a connection of its own, each re-checked by `requireFeature` |
| Transaction | `transaction.ts`: one connection per attempt, the core's `openingScript`, `withTransactionRetry`, the FATAL watcher, abort; `cancel.ts`: CancelRequest, `ROLLBACK`, then close; `abort.ts`: `TransactionAbortedError` |
| Tests | `packages/pg/test`: `capabilities`, `transaction` and `session`, against the harness's PostgreSQL and PgBouncer |

## Falsifiers

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
| --- | --- | --- | --- |
| G1 | `bun run ready` exits 0 on the head | `ready` | the controls below |
| G2 | A named statement is refused on `pgBouncer(0)` and `supavisor`, allowed on `pgBouncer(1000)`, `hyperdrive` and `direct` | `capabilities.test.ts` | remove the check in `executorFor` |
| G3 | A transaction-pooled database has no `listen` and no `withAdvisoryLock`, at run time and in the type of what `createDatabase` returns; a direct one has both, and they work (a notification arrives; a session lock excludes another session) | `capabilities.test.ts`, `vp check` | build the session methods for every mode; widen the pooled overload to `TxClient & Pick<SessionMethods, "listen">` (`vp check` fails) |
| G4 | Pipelining is refused where the catalogue says `no` or `unverified`, and allowed where it was measured or the caller accepts it | `capabilities.test.ts` | drop the `requireFeature` call |
| G5 | The isolation level and every timeout are in force inside the transaction; a statement timeout ends it once with kind `statement-timeout` | `transaction.test.ts` | send the timeouts as session settings |
| G6 | A deadlock and a serialization failure each re-run the whole body, and both transactions commit; a unique violation runs once; `retry: false` runs once | `transaction.test.ts` | always pass `retry: false` |
| G7 | An abort in the middle of a transaction rolls it back and frees its lock; closing the socket alone does not (control); an abort during `COMMIT` is an unknown outcome | `transaction.test.ts` | close the socket without the cancel |
| G8 | The SQLSTATE of an idle-in-transaction timeout reaches the caller and the body runs once | `transaction.test.ts` | throw the query's error instead of the watcher's |
| G9 | 20 concurrent withdrawals through the adapter (pool of 5 over PgBouncer's 2) keep the balance exact | `transaction.test.ts` | use the row-lock statement without `FOR UPDATE` |
| G10 | A call whose signal aborts while it waits for a pool connection never runs its body | `transaction.test.ts` | check the signal only before `pool.connect()` |
| G11 | A session of its own that the server ends reports it (`onError`, `lost`) and does not kill the process; a setup that fails closes its connection | `session.test.ts` | leave the `'error'` listener off |

## Constraints on the implementation

- Free on mechanism: the pool, the cancel and the watcher may change as long as the journey and the falsifiers hold.
- Tests wait for the server's own timers or for a statement to run: the first by real time (100 ms timers, a 600 ms wait), the second by polling `pg_stat_activity`.

## Risks

| Risk | Mitigation |
| --- | --- |
| Hyperdrive may not forward a CancelRequest, or notice a closed socket (both unverified) | The adapter cancels, sends `ROLLBACK`, then closes; the `ROLLBACK` is what was measured through Hyperdrive by another project (`request-abort`: an explicit client rollback); the wizard's probe will settle the rest |
| The CancelRequest is plain TCP even when the main connection uses TLS, so the secret of the BackendKeyData crosses the network in clear | Recorded, not fixed: node-postgres has no TLS cancel for a pooled client. Where the network between the client and the pooler is not trusted, the `ROLLBACK` and the close still end an idle transaction; a statement that is running keeps its locks until it ends |
| The declared mode is wrong | Documented; the adapter has no detection to be wrong with |
| A body with a side effect outside the database runs twice | The contract says the body MUST be safe to run again; `tx.attempt` tells it which run it is |
| node-postgres internals (`processID`, `secretKey`, `connection.stream`) | A typed augmentation of `pg` in `cancel.ts`; the pinned `pg` 8.23.1; the tests cover the cancel |

## Open questions for the operator

1. postgres.js is next in the roadmap: Cloudflare and Supabase disagree about `prepare: false` there; a probe settles it. Same shape of adapter?

## Revisions

- **2026-10-29, plan written** with the build.
- **2026-10-29, build deviations (found while building).**
  1. **Closing the socket is not an abort.** The first version destroyed the socket on abort; the test showed the aborted transaction's lock still held, because a backend that is running a statement (`pg_sleep(30)` here) does not notice the closed socket until the statement ends (`client_connection_check_interval` defaults to 0, <https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL>). The adapter now cancels first. The catalogue row `request-abort` says so, and a control test pins the behaviour.
  2. **`query` and `transaction.query` return `Row[]` of node-postgres, not a generic row type**: a caller-chosen row type is a cast with a name.
  3. **The harness gained `startStack`** (PostgreSQL and PgBouncer for an adapter's tests) and the adapter's tests use it; the harness's own test fixtures use it too.
  4. **The CancelRequest moved to the core** as `@pg-txmode/core/cancel` (a separate entry: it uses Node's `net`, the main entry stays portable). The harness and the adapter had each written the same 13 lines; the duplication gate (threshold 0) failed, and one construct per problem is the rule.
- **2026-10-29, after review round 1 of PR #4 (recorded by `omp-reviewer-pr4` at `a366fa9`; none changes the journey beyond what is said).**
  1. **The type half of G3 now has a control.** `createDatabase`'s two overloads are written by hand, and the type test looked at the helper `Database<Mode>`, not at what `createDatabase` returns: a change to an overload could pass `vp check` (the reviewer's change did). The test now takes `expectTypeOf` of the value `createDatabase` returns, for a pooled and for a direct mode. Control run: widening the pooled overload to `TxClient & Pick<SessionMethods, "listen">` makes `vp check` fail (TS2741 on the implementation, TS2554 on `not.toHaveProperty("listen")`).
  2. **An abort while a call waits for a pool connection is honoured.** `runOnce` checked the signal once, before `pool.connect()`, and registered its listener after; a signal that fired while the call was queued was lost and the body ran and committed. It now checks again after the connection arrives, gives it back untouched, and throws `TransactionAbortedError(false)` (new test with `maxConnections: 1`). The abort listener also ignores a signal that fires after a successful `COMMIT`.
  3. **Session clients report their loss and do not leak.** `listen` and `withAdvisoryLock` made a `Client` with no `'error'` listener, so a terminated backend was an uncaught exception. `listen` now takes a required `onError(error)` (called once); the body of `withAdvisoryLock` receives a `lost` `AbortSignal` whose reason is the error; a failing `LISTEN` or `pg_advisory_lock` ends the client before the cause is thrown.
  4. **The abort sends `ROLLBACK` after the cancel, each step bounded by 2 s, then closes the socket.** The evidence for Hyperdrive (`request-abort`) is an explicit client rollback, not a closed socket, so the adapter now does what was measured, and a pooler that does not forward the cancel or an unreachable one cannot hold the close back (finding: the cancel had no timeout). Whether Hyperdrive forwards a CancelRequest, or notices a closed socket, is `unverified`; the Risks row says so. **No server-side test can tell the `ROLLBACK` step from its absence**: removing it left every test green, because on a direct server and behind PgBouncer the closed socket ends the transaction the same way. Only a deployed Hyperdrive probe could; round 2 added a call-order test (below).
  5. **`request-abort` is split into idle and busy** (`request-abort-busy`, probe `abort-busy-holds-locks`): the idle probe was the only measurement, and the busy case (a backend running a statement keeps its locks after the socket closes) is observed on PostgreSQL directly and through PgBouncer. The row's Hyperdrive note now says the measured rollback was an explicit one.
  6. **Declared, found undeclared:** `RetryEnvironment` of the core accepts `undefined` for its four members (`exactOptionalPropertyTypes`: an option the adapter passes through may be absent); `TxClient` carries `mode` and `capabilities` beside `query`, `transaction` and `end` (the Goal comment above lists them now). `NamedStatementRefusedError` quotes the cell of the mode asked about (`cellOf`), so Supavisor's refusal quotes Supabase's wording, not PgBouncer's. Not changed, recorded as a risk: the CancelRequest goes over plain TCP even when the main connection uses TLS, so the BackendKeyData secret crosses the network in clear.
  7. **Evidence figures** quoted in the PR body now have their raw output in PR comments (the C4 list, C6, the load figure, the probe count).
- **2026-10-29, after review round 2 of PR #4 (recorded by `omp-reviewer-pr4` at `afc310d`: pass, with lows).**
  1. **The `ROLLBACK` step has a control, of a kind.** `packages/pg/test/cancel.test.ts` calls `cancelAndClose` on a stand-in client and asserts the order of calls (`ROLLBACK`, then the socket is destroyed), that a failing or silent `ROLLBACK` still ends in the close, and that the grace period is honoured (100 ms in the test; 2 s by default). This pins what the adapter sends. It does not prove that Hyperdrive acts on it: against a real server the closed socket ends the transaction anyway. `cancelAndClose` now takes the narrow type `Abortable` and a `graceMs` argument for that.
  2. **Not done:** racing `pool.connect()` against the signal. An aborted call that waits for a connection still waits until one is free, then gives it back untouched and throws; the body never runs (G10).
  3. The round 1 entry above names the reviewer as recorded on the PR (`omp-reviewer-pr4`), not the name of the agent that was asked.
