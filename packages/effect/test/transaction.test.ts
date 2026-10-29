import { assert, layer } from "@effect/vitest";
import {
  Array as Arr,
  Latch,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
} from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";

import {
  hyperdriveLayer,
  InvalidTransactionOptionsError,
  ModeRefusedError,
  NestedTransactionError,
  pgBouncerLayer,
  TxAttempt,
  TxClient,
} from "../src/index.ts";
import {
  busyBackends,
  fixture,
  Observer,
  Servers,
  untilRunning,
} from "./stack.ts";

/**
 * `TxClient.transaction` against PgBouncer in transaction mode (two server connections): the options are in force inside
 * the transaction, 40001 and 40P01 run the whole body again, interruption leaves no transaction open, and every other
 * failure runs once. What the server says is read through a client of its own on PostgreSQL (`Observer`).
 */

const tables = Layer.effectDiscard(
  Effect.gen(function* () {
    const observer = yield* Observer;

    yield* observer`create table account (id int primary key, balance int not null check (balance >= 0))`;
    yield* observer`create table note (k int primary key)`;
    yield* observer`create table ledger (k int primary key)`;
  })
).pipe(Layer.provideMerge(fixture));

/** PgBouncer with tracked names, `connections` client connections in the pool. */
const pooled = (connections: number) =>
  Layer.unwrap(
    Effect.map(Servers, (servers) =>
      pgBouncerLayer(1000, {
        maxConnections: connections,
        url: Redacted.make(servers.tracked.endpoint.url),
      })
    )
  );

/** Two parties wait for each other; a later call (a retry) passes at once. */
const meeting = Effect.gen(function* () {
  const first = yield* Latch.make();
  const second = yield* Latch.make();

  return (me: 0 | 1) =>
    me === 0
      ? Effect.andThen(Latch.open(first), Latch.await(second))
      : Effect.andThen(Latch.open(second), Latch.await(first));
});

const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

/** `effect`, and how many times it started. */
const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const runs = { count: 0 };

  return {
    effect: Effect.suspend(() => {
      runs.count += 1;

      return effect;
    }),
    runs,
  };
};

const hyperdrive = (allowUnverified: boolean) =>
  Layer.unwrap(
    Effect.map(Servers, (servers) =>
      hyperdriveLayer({
        allowUnverified,
        url: Redacted.make(servers.tracked.endpoint.url),
      })
    )
  );

layer(tables, { excludeTestServices: true, timeout: "90 seconds" })(
  "transaction",
  (suite) => {
    suite.layer(pooled(4), { buildPerTest: true })((it) => {
      it.effect(
        "the isolation level and every timeout hold inside the transaction and are gone after it",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;

            const inside = yield* tx.transaction(
              Effect.map(
                sql`select current_setting('transaction_isolation') as level,
                current_setting('statement_timeout') as statement,
                current_setting('lock_timeout') as lock,
                current_setting('idle_in_transaction_session_timeout') as idle,
                current_setting('transaction_read_only') as read_only`,
                (rows) => rows[0]
              ),
              {
                isolation: "serializable",
                readOnly: true,
                timeouts: {
                  idleInTransactionMs: 5000,
                  lockMs: 500,
                  statementMs: 3000,
                },
              }
            );

            assert.deepStrictEqual(inside, {
              idle: "5s",
              level: "serializable",
              lock: "500ms",
              read_only: "on",
              statement: "3s",
            });

            const after =
              yield* sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`;

            assert.deepStrictEqual(after[0], { lock: "0", statement: "0" });
          })
      );

      it.effect(
        "a statement timeout ends the transaction once, as a typed SqlError",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            const slow = counted(sql`select pg_sleep(5)`);

            const error = yield* Effect.flip(
              tx.transaction(slow.effect, { timeouts: { statementMs: 100 } })
            );

            assert.strictEqual(slow.runs.count, 1);
            assert.instanceOf(error, SqlError);
            assert.strictEqual(error.reason._tag, "StatementTimeoutError");
          })
      );

      it.effect(
        "a serialization failure and a deadlock each run the whole body again, and both transactions commit",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            const observer = yield* Observer;
            const attempts: number[] = [];

            yield* observer`insert into account values (1, 0), (2, 0)`;

            const crossed = yield* meeting;
            const read = yield* meeting;

            const deadlocking = (me: 0 | 1) =>
              tx.transaction(
                Effect.gen(function* () {
                  attempts.push(yield* TxAttempt);
                  yield* sql`set local deadlock_timeout = '50ms'`;
                  yield* sql`select 1 from account where id = ${me + 1} for update`;
                  yield* crossed(me);
                  yield* sql`select 1 from account where id = ${2 - me} for update`;
                }),
                { retry: { ...noDelay, maxAttempts: 5, retryDeadlocks: true } }
              );

            const skewing = (me: 0 | 1) =>
              tx.transaction(
                Effect.gen(function* () {
                  attempts.push(yield* TxAttempt);
                  yield* sql`select sum(balance) from account`;
                  yield* read(me);
                  yield* sql`update account set balance = balance + 1 where id = ${me + 1}`;
                }),
                {
                  isolation: "serializable",
                  retry: { ...noDelay, maxAttempts: 5, retryDeadlocks: true },
                }
              );

            yield* Effect.all([deadlocking(0), deadlocking(1)], {
              concurrency: 2,
            });

            const afterDeadlock = attempts.length;

            yield* Effect.all([skewing(0), skewing(1)], { concurrency: 2 });

            // A retry is a whole body run: each pair ran more than twice, and a retried run knew it was a later attempt.
            assert.isAbove(afterDeadlock, 2);
            assert.isAbove(attempts.length - afterDeadlock, 2);
            assert.isTrue(Arr.some(attempts, (attempt) => attempt > 1));

            const rows =
              yield* observer`select sum(balance)::int as n from account`;

            // Both skewing transactions committed exactly once: the sum is 2, not 1 (a lost run) and not 4 (a repeated commit).
            assert.strictEqual(rows[0]?.n, 2);
          })
      );

      it.effect(
        "control: `retry: false` runs the body once and fails with the serialization failure",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            const attempts: number[] = [];
            const clash = yield* meeting;

            const run = (me: 0 | 1) =>
              Effect.exit(
                tx.transaction(
                  Effect.gen(function* () {
                    attempts.push(yield* TxAttempt);
                    yield* sql`select sum(balance) from account`;
                    yield* clash(me);
                    yield* sql`update account set balance = balance + 1 where id = ${me + 1}`;
                  }),
                  { isolation: "serializable", retry: false }
                )
              );

            const exits = yield* Effect.all([run(0), run(1)], {
              concurrency: 2,
            });

            assert.strictEqual(Arr.filter(exits, Exit.isFailure).length, 1);
            assert.deepStrictEqual(attempts, [1, 1]);
          })
      );

      it.effect(
        "the retry budget is bounded and the last failure stays a typed SqlError",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;

            const failing = counted(
              sql`do $$ begin raise exception 'again' using errcode = '40001'; end $$`
            );

            const error = yield* Effect.flip(
              tx.transaction(failing.effect, {
                retry: { ...noDelay, maxAttempts: 3, retryDeadlocks: true },
              })
            );

            assert.strictEqual(failing.runs.count, 3);
            assert.instanceOf(error, SqlError);
            assert.strictEqual(error.reason._tag, "SerializationError");
          })
      );

      it.effect(
        "a unique violation, a failure of the body and a refused deadlock each run the body once",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            const observer = yield* Observer;
            const runs = { body: 0, deadlock: 0, unique: 0 };

            yield* observer`insert into note values (10)`;

            const unique = yield* Effect.flip(
              tx.transaction(
                Effect.suspend(() => {
                  runs.unique += 1;

                  return sql`insert into note values (10)`;
                })
              )
            );

            const failing = yield* Effect.flip(
              tx.transaction(
                Effect.suspend(() => {
                  runs.body += 1;

                  return Effect.fail("the body failed" as const);
                })
              )
            );

            const deadlock = yield* Effect.flip(
              tx.transaction(
                Effect.suspend(() => {
                  runs.deadlock += 1;

                  return sql`do $$ begin raise exception 'dead' using errcode = '40P01'; end $$`;
                }),
                {
                  retry: { ...noDelay, maxAttempts: 5, retryDeadlocks: false },
                }
              )
            );

            assert.deepStrictEqual(runs, { body: 1, deadlock: 1, unique: 1 });
            assert.instanceOf(unique, SqlError);
            assert.strictEqual(unique.reason._tag, "UniqueViolation");
            assert.strictEqual(failing, "the body failed");
            assert.instanceOf(deadlock, SqlError);
            assert.strictEqual(deadlock.reason._tag, "DeadlockError");
          })
      );

      it.effect(
        "interrupting a transaction that runs a statement leaves no transaction open and commits nothing",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            const observer = yield* Observer;

            const fiber = yield* Effect.forkChild(
              tx.transaction(
                Effect.andThen(
                  sql`insert into ledger values (1)`,
                  sql`select pg_sleep(30)`
                )
              )
            );

            yield* untilRunning("select pg_sleep(30)");

            // The control: the observer does see the open transaction while it runs, so "none" afterwards means something.
            assert.isAbove(yield* busyBackends, 0);

            yield* Fiber.interrupt(fiber);

            // Interruption returned, so the transaction is already over: nothing is awaited here.
            assert.strictEqual(yield* busyBackends, 0);
            assert.strictEqual(
              (yield* observer`select count(*)::int as n from ledger`)[0]?.n,
              0
            );
            assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
          })
      );

      it.effect(
        "a nested transaction is refused: it would drop the options silently",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;

            const error = yield* Effect.flip(
              tx.transaction(
                tx.transaction(Effect.void, { isolation: "serializable" })
              )
            );

            assert.instanceOf(error, NestedTransactionError);
          })
      );

      it.effect(
        "a timeout that is not a non-negative integer is a typed error and sends nothing",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;

            const error = yield* Effect.flip(
              tx.transaction(Effect.void, { timeouts: { statementMs: -1 } })
            );

            assert.instanceOf(error, InvalidTransactionOptionsError);
          })
      );
    });

    suite.layer(pooled(1), { buildPerTest: true })((it) => {
      it.effect(
        "a transaction interrupted while it waits for a connection never runs its body",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;
            const sql = yield* SqlClient.SqlClient;
            let ran = false;

            // The pool has one connection: the first transaction holds it.
            const holder = yield* Effect.forkChild(
              tx.transaction(sql`select pg_sleep(3)`)
            );

            yield* untilRunning("select pg_sleep(3)");

            const waiting = yield* Effect.forkChild(
              tx.transaction(
                Effect.sync(() => {
                  ran = true;
                })
              )
            );

            yield* Effect.yieldNow;
            yield* Fiber.interrupt(waiting);
            yield* Fiber.interrupt(holder);

            assert.isFalse(ran);
            assert.strictEqual(yield* busyBackends, 0);
          })
      );
    });

    suite.layer(hyperdrive(false), { buildPerTest: true })((it) => {
      it.effect(
        "an isolation level that Hyperdrive has not been shown to honour is refused unless the caller accepts it",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;

            const refused = yield* Effect.flip(
              tx.transaction(Effect.void, { isolation: "serializable" })
            );

            assert.instanceOf(refused, ModeRefusedError);
            assert.strictEqual(refused.row, "isolation-level");
            assert.strictEqual(refused.support, "unverified");
            assert.match(refused.message, /catalogue row isolation-level/u);
          })
      );
    });

    suite.layer(hyperdrive(true), { buildPerTest: true })((it) => {
      it.effect(
        "control: the same request is accepted with `allowUnverified`",
        () =>
          Effect.gen(function* () {
            const tx = yield* TxClient;

            yield* tx.transaction(Effect.void, { isolation: "serializable" });
          })
      );
    });
  }
);
