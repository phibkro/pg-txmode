# 0003 The Effect adapter: `@pg-txmode/effect`

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's assignment of 2026-10-29 ("an out-of-the-box Postgres library for Effect, as we are doing with transactions": a pg-txmode adapter for Effect v4).
Process: [spec 0000](0000-development-lifecycle.md). Based on `main` (specs 0000, 0001 and 0002 are merged).
Verify skill: `verify-pg-txmode` (updated in this PR: path-table row `packages/effect/**`, and `probes:effect`).
Worked against: `effect` 4.1.0 and `@effect/sql-pg` 4.1.0 (the latest on npm on 2026-10-29), pinned `>=4.1.0 <4.2.0` as peers. `effect/sql` and `@effect/sql-pg` are marked `@stability unstable` in the installed source.

## Problem

An Effect program that talks to PostgreSQL through a transaction pooler (Hyperdrive, PgBouncer, Supavisor) meets the same traps as any client, with three Effect-shaped ones on top:

1. **The default client hangs.** `PgClient` of `@effect/sql-pg` sends named prepared statements by default. Behind PgBouncer with `max_prepared_statements = 0` (or Supavisor's shared pooler) the statements vanish, transactions fail with SQLSTATE 26000, and the last transactions never complete: no error reaches the caller. This is the M2b finding of the research report; on 4.1.0 it reproduces (`docs/evidence/effect/designs.txt`: 6, 17 and 20 of 800 transactions committed in three runs, then a hang each time, killed after 60 s).
2. **The transaction door is thin.** `SqlClient.withTransaction` starts a transaction, but isolation level and timeouts cost a hand-written provider and extra statements, and nothing retries a whole transaction after 40001 or 40P01 ([Effect-TS/effect#10127](https://github.com/Effect-TS/effect/issues/10127): it has no such combinator, and `SqlError.isRetryable` is true for connection errors and timeouts that must not be replayed).
3. **The type says nothing about the mode.** `PgClient` offers `listen` and `notify` whatever stands in front of the database, and a program that listens or takes a session advisory lock compiles against a pooler that cannot honour it.

## Goal

`@pg-txmode/effect`: layers, one per connection mode, that give an Effect program a `SqlClient` (so `SqlModel`, `SqlSchema`, a Transactor or Drizzle on top of it keep working) and a transaction door whose behaviour is the capability record of the mode, derived from the core and written nowhere else.

```ts
const Db = pgBouncerLayer(0, { url: Redacted.make(process.env.DATABASE_URL) });   // Layer<TxClient | SqlClient, SqlError | ModeRefusedError>

const program = Effect.gen(function* () {
  const tx = yield* TxClient;
  const sql = yield* SqlClient.SqlClient;

  return yield* tx.transaction(
    Effect.gen(function* () { /* the whole body; it runs again after 40001 and 40P01; `yield* TxAttempt` says which run */ }),
    { isolation: "serializable", timeouts: { statementMs: 3000, lockMs: 500 } }
  );
}).pipe(Effect.provide(Db));

const listening = Effect.gen(function* () { yield* (yield* TxSession).listen("jobs"); }).pipe(Effect.provide(Db));
//                                                                                            ^ the program still requires TxSession: it does not run
```

## Journey

```text
pgBouncerLayer(n, config) | hyperdriveLayer | supavisorLayer | neonLayer   → Layer<TxClient | SqlClient>
directLayer(config)       | sessionPooledLayer                             → Layer<TxClient | SqlClient | TxSession>
  build:  the mode's capabilities decide `prepare` (named statements only where the pooler tracks them); a request the mode
          cannot honour (prepare: true on pgBouncer(0), multiplex where pipelining is `no` or `unverified`) fails the build with
          ModeRefusedError: the catalogue row, its note and its sources
tx.transaction(body, options)  → BEGIN [ISOLATION LEVEL ..] ; SET LOCAL timeouts ; body ; COMMIT
                                 retried as a whole after 40001 and 40P01 (core `retryDecision`, as a Schedule on Effect's clock and Random)
                                 interrupted: the statement is cancelled, the transaction rolled back and the connection returned BEFORE the interrupt completes
session.listen / session.withAdvisoryLock  (TxSession: only a layer of a mode that keeps the session provides it)
bun run probes:effect          → the design probes (interruption through A and B; the M2b workload), raw
```

## Constraints and values

- **Fix through Effect's own services; never around them.** The client is `PgClient.make` of `@effect/sql-pg`; interruption, the pool, the cancel and the rollback are its. This package adds no timer, no queue, no pool, no runtime and no `node:crypto`. A retry is a `Schedule`; time and randomness are `Clock` and `Random`.
- **No second copy of a fact.** What a mode can do comes from the core: `capabilities(mode)`, `requireFeature`, `retryDecision`, `classifyFailure`, `beginStatement`, `timeoutStatements`. A test fails on a pooler name or setting read in `packages/effect/src`.
- **The capability is in the type.** A mode that keeps no session provides no `TxSession`; the requirement is unsatisfied and the program does not run (the core's `SessionApi`, as an Effect requirement). `PgClient` itself (with `listen`) is never provided, only its `SqlClient` view.
- **Refuse, do not detect** (spec 0002): the mode is declared by the caller; an unverified behaviour is refused unless `allowUnverified`.
- **Refuse any `@effect-diagnostics` directive and any lint suppression in published source.** The language service's diagnostics are all errors in `packages/effect/tsconfig.json`; a test fails on a directive of the Effect plugin family, of Oxlint, ESLint or TypeScript in `packages/effect`. Where a rule contradicts the installed Effect idiom, the rule is switched off in `vite.config.ts` with its reason (AGENTS.md, Exceptions), not suppressed in the code.
- **The Effect boundary stays a gate.** Only `packages/effect` depends on Effect, and the core, `pg`, the harness and the lint import none (`effectBoundary.test.ts`, extended from manifests to imports).
- **Unstable API exposure is a list.** The modules used are the `allowedUnstableApis` of `packages/effect/tsconfig.json`: `@effect/sql-pg/PgClient`, `@effect/sql-pg/PgConnection`, `@effect/vitest` (tests), `effect/reactivity/Reactivity`, `effect/sql/SqlClient`, `effect/sql/SqlError` (plus `effect/process/*` and the platform-node runtime in the test scripts). Any other unstable module is a type error.

## The design question, answered with evidence

The assignment asked: build on `effect/sql` and `@effect/sql-pg`'s `PgClient`, or on the `pg` adapter underneath? Three designs, two probed. (`effect/sql` is `effect/sql` in 4.1.0, not `effect/unstable/sql`; and `@effect/sql-pg` 4.1.0 is no longer a wrapper of node-postgres: it is a native wire-protocol client with its own pool, cancel and type codecs, and no dependency on `pg`.)

| | A. `PgClient.make` configured from the mode (**chosen**) | B. Effect over `@pg-txmode/pg` | C. A `SqlClient` built with `SqlClient.make` over node-postgres |
| --- | --- | --- | --- |
| Reuse | `SqlClient`, `Statement`, `SqlModel`, `SqlSchema`, migrator, `Reactivity`, transaction nesting, `afterCommit`: all of Effect's | the `pg` adapter's abort, retry and session code | the `pg` adapter's statement door and cancel; Effect's `SqlClient` shell |
| `SqlClient`-compatible | yes | **no**: a `transaction(body)` function around a Promise-returning body; an Effect body must be run inside the callback (`Effect.runPromise` in an effect, FX003) | yes, after writing a `Connection` (execute, values, stream, unprepared, raw), the statement compiler and the type codecs (`PgTypes` alone is 2131 lines in `@effect/sql-pg`) |
| Interruption mid-transaction | cancels the statement (CancelRequest on a side connection, over TLS when the connection uses it: `sendCancelRequest` in the driver's `PgConnection.ts`), rolls back, drains, returns the connection; **no backend busy when the interrupt returns** (probe: 1 busy while running, 0 on return, 0 after 600 ms) | **the interrupt returns while the backend still runs the statement** (probe: 1 busy on return, 0 after 600 ms): `Effect.promise`'s signal aborts, the promise settles later; a correct wrapper must await the promise uninterruptibly, which is more code | would have to write it |
| M2b | **reproduced** with `prepare: true` (hang); avoided by deriving `prepare` from the mode, and refused when asked for | not reproduced: node-postgres names a statement only when asked, and the `pg` adapter refuses names where untracked | not applicable until written |
| Hyperdrive | named statements by default (`prepare` follows `capabilities`); TLS cancel; the same refusals | unchanged `pg` behaviour (cancel over plain TCP: spec 0002, Risks) | as B |
| Drift risk | the unstable surface of `effect/sql` and `@effect/sql-pg`, pinned to `>=4.1.0 <4.2.0`; the two integration points are `PgClient.make` and `SqlClient.BeginTransaction` | the `pg` adapter's pinned internals (`processID`, `secretKey`) | the largest: `SqlClient.make`'s options and `Connection` are unstable and would be implemented by this package |
| Unstable exposure | named in `tsconfig.json` (5 modules) | none from Effect's SQL | as A, plus `Connection` |

**Chosen: A.** B loses the interruption law (the transaction outlives the interrupt) and the `SqlClient` contract; C reimplements the driver the Effect team ships and keeps the drift risk of A without its reuse. A's two costs, both recorded below, are the unstable surface and one extra round trip per timeout (the driver has no simple-query path, so `SET LOCAL` statements cannot travel in the `BEGIN` script of spec 0002).

Probe output: `docs/evidence/effect/designs.txt`, from `bun run probes:effect` (`packages/effect/scripts/designs.ts`).

## What is built

| Part | Content |
| --- | --- |
| Layers | `layers.ts`: `layer(mode, config)` with two overloads (`TransactionPooledMode` gives `Layer<TxClient \| SqlClient>`, `DirectMode \| SessionPooledMode` adds `TxSession`; a wide `ConnectionMode` has no overload, as in spec 0002) and one constructor per mode: `hyperdriveLayer`, `pgBouncerLayer(n, config)`, `supavisorLayer`, `neonLayer`, `directLayer`, `sessionPooledLayer` |
| Client | `client.ts`: `makePgClient(mode, config)` is `PgClient.make` with `prepare` from `capabilities(mode).preparedStatements`, `multiplex` only where `requireFeature(mode, "pipelining")` allows, `maxConnections` 5 (a Worker invocation holds six connections); `TxPgConfig` omits nothing else of `PgPoolConfig` (`url`, `ssl`, `stream`, `idleTimeout`, `acquireTimeout`, `connectionTTL`, ...) |
| Transaction | `txClient.ts`: `TxClient` (a `Context.Service`: `mode`, `capabilities`, `transaction(body, options)`), `makeTxClient(mode, sql, options)` over any `SqlClient`, `txClientLayer(mode)` for a test layer, `TxAttempt` (a `Context.Reference`: which run of the body) |
| Retry | `retry.ts`: `transactionRetrySchedule(policy)`, a `Schedule` built with `Schedule.fromStepWithMetadata` from the core's `retryDecision` and Effect's `Random`; `failureOfSqlError` reads the SQLSTATE of `SqlError.reason.cause` and gives it to the core's `failureOf` |
| Session | `session.ts`: `TxSession` (`listen`, `withAdvisoryLock(key, body)`): the lock sits on a reserved connection, `body` runs on the pool and is raced with a parked `pg_sleep` on the lock's connection, so a connection that ends interrupts the body with `AdvisoryLockLostError` |
| Errors | `errors.ts`: `ModeRefusedError` (feature, row, sources, support, message of the core's `UnsupportedFeatureError`), `InvalidTransactionOptionsError`, `NestedTransactionError`, `AdvisoryLockLostError`; all `Schema.TaggedError`, none recovered here |
| Tests | `packages/effect/test`: `layers`, `transaction`, `session`, `retry`, `knownIssues` (the pins), run against the harness's PostgreSQL and two PgBouncers (`max_prepared_statements` 1000 and 0) |
| Probes | `scripts/designs.ts` (`bun run probes:effect`); `test/m2bClient.ts` and `test/finalizerClient.ts` run a hung client in a process of its own |
| Gates | `check:effect` (`tsc -p packages/effect`, the Effect-patched compiler) added to `ready` and CI; the Effect plugin group in `vite.config.ts`; `effectBoundary.test.ts` extended |

The contract of each construct is in its module's header (channels, who owns what, when execution starts, interruption, retry, durability). In short: every constructor does nothing until built; the client's pool is owned by the layer's scope; `transaction` is lazy, keeps the body's requirements, adds `SqlError` and the refusals to its errors, retries in process only (no durability), and its interruption is `sql.withTransaction`'s.

## Falsifiers

Each has a negative control that was run and observed to fail (the PR body quotes them).

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
| --- | --- | --- | --- |
| E1 | `bun run ready` exits 0 on the head | `ready` | the controls below |
| E2 | Interrupting a fiber that runs a transaction leaves no transaction open when the interrupt returns and commits nothing (read from `pg_stat_activity` by a client on PostgreSQL itself, after the observer saw the transaction running) | `transaction.test.ts` | run the transaction in a detached fiber (the body outlives the interrupt): `expected 1 to equal 0`; design B in `probes:effect` shows the same observation failing |
| E3 | A mode-incompatible program does not typecheck: a pooled layer provides no `TxSession`; a program that requires it keeps the requirement | `layers.test.ts` (`expectTypeOf`), `check:effect`, `vp check` | give the pooled overload `TxSession` in its result: two TS2344 errors in the type tests |
| E4 | 40001 and 40P01 run the whole body again and both transactions commit; a unique violation, a refused deadlock and a body failure run once; the budget is bounded; the last failure is the typed `SqlError` | `transaction.test.ts`, `retry.test.ts` | never retry: `expected 1 to equal 3`; `retry: false` runs once and fails |
| E5 | The M2b workload either works or is refused at construction: `prepare: true` on `pgBouncer(0)` and on `supavisor` fails the build with the catalogue row; the layer's workload (400 transactions) completes behind `max_prepared_statements = 0`; the plain `PgClient` fails or hangs there | `layers.test.ts`, `knownIssues.test.ts` | derive `prepare` as always true: the `pgBouncer(0)` workload hangs and the "sends none" test fails |
| E6 | The mode checks are the core's: `TxClient.capabilities` equals `capabilities(mode)` for every constructor; refusals carry the core's row and message; no pooler name or setting is read in `packages/effect/src` | `layers.test.ts`, `effectBoundary.test.ts` | read `mode.pooler` in `src`: the boundary test fails |
| E7 | The Effect boundary: nothing outside `packages/effect` depends on or imports Effect (the root may list the checker `@effect/tsgo`) | `effectBoundary.test.ts` | import `effect` in a file of `packages/core`; list `effect` in the root or `@effect/tsgo` in a package |
| E8 | No suppression directive in `packages/effect` (Effect language service, Effect plugin, Oxlint, ESLint, TypeScript) | `effectBoundary.test.ts` | a directive in `src`: the test fails; `exceptions.json` stays free of Effect entries |
| E9 | Every Effect language-service diagnostic is an error and gates | `check:effect` | `export async function f() {}` and `setTimeout` in `src`: TS377081, TS377072, exit 1 |
| E10 | Isolation, access mode and each `SET LOCAL` timeout are in force inside the transaction and gone after it; an unverified capability (Hyperdrive's isolation level) is refused unless `allowUnverified`; a nested `transaction` and an invalid timeout are typed errors | `transaction.test.ts` | the "after" read in the same test; the same request with `allowUnverified` is accepted |
| E11 | `TxSession` works where it exists: a notification arrives; a session advisory lock excludes another session and is freed by completion or interruption; a lock whose connection the server ends fails the body with `AdvisoryLockLostError` | `session.test.ts` | the body is still running while the connection lives (asserted before the backend is terminated) |
| E12 | The pool finalizer hang ([#10128](https://github.com/Effect-TS/effect/issues/10128)) is pinned for `PgClient.make` in the finalizer's scope and absent from a client built by a layer, ours included | `knownIssues.test.ts` | the `make` run hangs; the layer runs close (`finalizer query ok`, `closed`) |
| E13 | Building and discarding a layer does no work: no connection, no throw | `layers.test.ts` | each constructor is built against a port nothing listens on |

## Constraints on the implementation

- Free on mechanism: how the lock is held, how the schedule is built and how errors are mapped may change if the journey and the falsifiers hold.
- Tests wait on the server (`pg_stat_activity`) or on an Effect `Latch`; time moves through `TestClock` where only the schedule is under test. The pins run a hung client in a child process because its interruption waits for the statement that never answers.

## Risks

| Risk | Mitigation |
| --- | --- |
| `effect/sql` and `@effect/sql-pg` are unstable | Peer range `>=4.1.0 <4.2.0`; the unstable modules are listed in `tsconfig.json`; the pins in `knownIssues.test.ts` say when a defect is gone |
| Hyperdrive may not honour a CancelRequest, or may not notice a closed socket | Unverified (catalogue `request-abort`, `cancel-request`); interruption is the driver's: it sends the cancel (over TLS when the connection is TLS) and a `ROLLBACK`. The package does not claim more than the catalogue says |
| `prepareTransactionControls: true` in `@effect/sql-pg` makes `BEGIN` and `COMMIT` named statements on `prepare: true` clients | Only where the mode tracks names (`prepare` follows `capabilities`); with names off the driver falls back to the unnamed path (its source says so) |
| One round trip per `SET LOCAL` (the driver has no simple-query path) | Recorded as a cost [inference from the driver source: no simple-query encoder in `PgConnection.ts`; not counted on the wire]; a timeout is optional, and the isolation level travels in the `BEGIN` statement itself |
| The layer's `maxConnections` default of 5 is a Worker limit, not a PostgreSQL one | Same default as spec 0002; the caller overrides it |
| A body with a side effect outside the database runs twice | The contract says the body MUST be safe to run again; `TxAttempt` tells it which run it is |

## Open questions for the operator

1. **Name and publication.** The package is `@pg-txmode/effect` (the monorepo's `packages/<x>` is `@pg-txmode/<x>`, and the boundary test already named `packages/effect`). It is `private: true` like the others; a publish spec would set the versions.
2. **Upstream.** [#10127](https://github.com/Effect-TS/effect/issues/10127) (the retry combinator) and [#10128](https://github.com/Effect-TS/effect/issues/10128) (the pool finalizer) are the operator's and open. New finding of this spec that was **not filed** (the lead decides): `@effect/sql-pg` 4.1.0 with the default `prepare: true` behind a pooler that does not track names ends in 26000 failures and a hang, with no typed error (M2b; the reproduction is `packages/effect/test/m2bClient.ts`).

## Revisions

Dated entries. A spec is revised only here; its text above is never edited silently after the PR opens.

- **2026-10-29, plan written** with the build.
- **2026-10-29, build deviations (found while building; none changes the journey or a falsifier).**
  1. **The design question changed under the evidence.** The assignment assumed `@effect/sql-pg` sits on node-postgres. 4.1.0 is a native client, so design C (own `SqlClient` over node-postgres) is a rewrite, not a bridge, and design B is the only one that keeps `pg`. Both A and B were probed; A was chosen (table above).
  2. **The pool finalizer hang needs no workaround here.** The first version forked the client's scope (`Scope.fork`) to run finalizers first. The control showed that a client built by a *layer* (`PgClient.layer` and this package's) never hangs, because a layer builds in a scope of its own that closes after the finalizers registered later in the caller's scope; only `PgClient.make` built in the finalizer's own scope hangs. The fork was removed (YAGNI) and the finding is pinned (E12). Nothing was patched; nothing is reported beyond #10128, whose cause reading is confirmed for the `make` case.
  3. **`vp check` does not run the Effect language-service diagnostics or the `effecttsgo/*` lint rules.** Observed: `Object.values(...)`, an async function and `setTimeout` in `packages/effect/src` pass `vp check` and fail `tsc -p packages/effect` (TS377143, TS377081, TS377072). So `check:effect` is a gate of its own (`ready`, CI), and the Oxlint presets of `@effect/tsgo` are not configured (they would be dead). The Oxlint Effect plugin (`effect/*` rules, scoped by role to `packages/effect`) does run in `vp check`.
  4. **Rule switches in `vite.config.ts`, scoped to `packages/effect/**`, each with its reason there:** `eslint/func-names` off (`Effect.gen(function* () {})` must be anonymous), `typescript/promise-function-async` off (the diagnostic `asyncFunction` forbids async functions; foreign Promises are wrapped with `Effect.promise`), `unicorn/no-array-method-this-argument` off (reads `Arr.every(xs, fn)` as a `thisArg` call). `eslint/max-classes-per-file` and `unicorn/throw-new-error` are off for `src/errors.ts` (a closed set of `Schema.TaggedError` classes) and `max-classes-per-file` for `test/stack.ts`. None is a suppression directive.
  5. **`SET LOCAL` timeouts cost one round trip each** (spec 0002 sent the opening as one simple-query script). `@effect/sql-pg` has no simple-query path; the isolation level and access mode still travel in the `BEGIN` statement (`SqlClient.BeginTransaction`).
  6. **Isolation and timeouts are capability-gated** (`isolationLevel`, `transactionLocalSettings` through `requireFeature`), which spec 0002's `pg` adapter does not do: with Hyperdrive `isolationLevel` is `unverified`, so a serializable transaction needs `allowUnverified: true` there. The core's rule (an unverified behaviour is not a safe one) applied; that the pg adapter does not gate them is recorded here and not changed (spec 0002 is merged).
  7. **A nested `transaction` is a typed error** (`NestedTransactionError`), not a savepoint: the savepoint would drop the options and a retry inside it cannot help. `sql.withTransaction` remains the savepoint door.
  8. **The catalogue row `named-statements-untracked` now says the hang reproduces on 4.1.0** (core text, `docs:gen` run; the README table is unchanged). The harness's own pin (node-postgres) is unchanged.
  9. **The root `package.json` lists `@effect/tsgo`** (the checker, run by `prepare` and `check:effect`); the boundary test allows exactly that one Effect package at the root.
  10. **Not done:** a Hyperdrive run of any kind (no credentials: wizard `docs/wizard/hyperdrive-probe.md`); Drizzle `effect-postgres` and `SqlModel` on top (a later spec); a `layerConfig` variant reading `Config` (the caller composes `Layer.unwrap` with `Config`); counting the `SET LOCAL` round trips on the wire.
