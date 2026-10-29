# 0002 The `pg` (node-postgres) adapter

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's assignment of 2026-10-29 ("apply the capability record; refuse session-only APIs; offer a transaction helper with retry and `SET LOCAL` timeouts").
Process: [spec 0000](0000-development-lifecycle.md). Stacked on the branch of PR #3 (spec 0001).
Verify skill: `verify-pg-txmode` (path table row `packages/pg/**`).

## Problem

The core knows what a transaction pooler breaks. A client still has to be built so that the broken thing cannot be reached: node-postgres will happily `LISTEN` on a pooled connection, send a named statement that PgBouncer does not track, hold an advisory lock in a session that belongs to nobody, or finish a transaction after the request that started it is gone. Cloudflare recommends `pg` first for Hyperdrive, and Drizzle (node-postgres), Kysely and Prisma's `adapter-pg` sit on it (report section 7; that they accept a caller-built client is unverified here).

## Goal

`@pg-txmode/pg`: a thin adapter over node-postgres whose behaviour is the capability record of the mode it is given, and nothing of its own.

```ts
const db = createDatabase({ connectionString, mode: pgBouncer(1000) });   // TxClient: query, transaction, end
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
- **A transaction does not outlive its request.** On abort the adapter sends a CancelRequest, then closes the socket; PostgreSQL rolls the transaction back. After `COMMIT` was sent the outcome is unknown and the error says so.
- **The server's FATAL is not lost.** node-postgres reports an idle-in-transaction or transaction timeout only as an `'error'` event (spec 0001, Revisions 5); the adapter keeps the first event and throws it, so the SQLSTATE reaches `failureOf`.
- No Effect, no new dependency beyond `pg` and the core.

## What is built

| Part | Content |
| --- | --- |
| `createDatabase` | `database.ts`: overloads give `TxClient` for a transaction-pooled mode and `TxClient & SessionMethods` for `Direct` and `SessionPooled`; pool of at most 5 (a Worker invocation can hold six outgoing connections) |
| Statement door | `statement.ts`: every statement passes `executorFor(mode)`; a name on a mode that does not track named statements throws `NamedStatementRefusedError` quoting the catalogue row |
| Session methods | `session.ts`: `listen` and `withAdvisoryLock`, each on a connection of its own, each re-checked by `requireFeature` |
| Transaction | `transaction.ts`: one connection per attempt, the core's `openingScript`, `withTransactionRetry`, the FATAL watcher, abort; `cancel.ts`: CancelRequest then close; `abort.ts`: `TransactionAbortedError` |
| Tests | `packages/pg/test`: 25 tests against the harness's PostgreSQL and PgBouncer |

## Falsifiers

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
| --- | --- | --- | --- |
| G1 | `bun run ready` exits 0 on the head | `ready` | the controls below |
| G2 | A named statement is refused on `pgBouncer(0)` and `supavisor`, allowed on `pgBouncer(1000)`, `hyperdrive` and `direct` | `capabilities.test.ts` | remove the check in `executorFor` |
| G3 | A transaction-pooled database has no `listen` and no `withAdvisoryLock`, at run time and in its type; a direct one has both, and they work (a notification arrives; a session lock excludes another session) | `capabilities.test.ts`, `vp check` | build the session methods for every mode |
| G4 | Pipelining is refused where the catalogue says `no` or `unverified`, and allowed where it was measured or the caller accepts it | `capabilities.test.ts` | drop the `requireFeature` call |
| G5 | The isolation level and every timeout are in force inside the transaction; a statement timeout ends it once with kind `statement-timeout` | `transaction.test.ts` | send the timeouts as session settings |
| G6 | A deadlock and a serialization failure each re-run the whole body, and both transactions commit; a unique violation runs once; `retry: false` runs once | `transaction.test.ts` | always pass `retry: false` |
| G7 | An abort in the middle of a transaction rolls it back and frees its lock; closing the socket alone does not (control); an abort during `COMMIT` is an unknown outcome | `transaction.test.ts` | close the socket without the cancel |
| G8 | The SQLSTATE of an idle-in-transaction timeout reaches the caller and the body runs once | `transaction.test.ts` | throw the query's error instead of the watcher's |
| G9 | 20 concurrent withdrawals through the adapter (pool of 5 over PgBouncer's 2) keep the balance exact | `transaction.test.ts` | use the row-lock statement without `FOR UPDATE` |

## Constraints on the implementation

- Free on mechanism: the pool, the cancel and the watcher may change as long as the journey and the falsifiers hold.
- Tests wait for the server's own timers or for a statement to run: the first by real time (100 ms timers, a 600 ms wait), the second by polling `pg_stat_activity`.

## Risks

| Risk | Mitigation |
| --- | --- |
| Hyperdrive may not forward a CancelRequest (unverified) | The adapter cancels, then closes: the close alone rolls back an idle transaction (probed behind PgBouncer; measured through Hyperdrive by another project, `request-abort`); the wizard's probe will settle the cancel |
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
