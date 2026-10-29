/**
 * The probes behind the design choice of spec 0003, as a user runs them: `bun run probes:effect`.
 *
 * Design A is this package (`@effect/sql-pg`'s native client, configured from the mode). Design B is an Effect wrapper over
 * `@pg-txmode/pg` (node-postgres). Each is put through the same two observations against the test fixture's PostgreSQL and
 * PgBouncer (transaction mode; `test/stack.ts`):
 *
 * 1. interrupt a fiber that runs a transaction (an insert, then `pg_sleep(30)`), and read `pg_stat_activity` at the moment
 *    the interrupt returns and 600 ms later: is a transaction still open, and is the row committed?
 * 2. the M2b workload (research report): 800 transactions of three parameterised statements, eight at a time, behind
 *    PgBouncer with `max_prepared_statements` 0 and 1000, with the plain `PgClient` (`prepare: true`) and with this
 *    package's layer (`test/m2bClient.ts`, a process of its own, killed after 60 s).
 *
 * Prints one line per probe; the raw text is the evidence (docs/evidence/effect/designs.txt).
 */
import { NodeRuntime } from "@effect/platform-node";
import { pgBouncer } from "@pg-txmode/core";
import { createDatabase } from "@pg-txmode/pg";
import {
  Array as Arr,
  Clock,
  Console,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql";

import { pgBouncerLayer, TxClient } from "../src/index.ts";
import { processes, runScript } from "../test/process.ts";
import {
  busyBackends,
  fixture,
  Observer,
  Servers,
  untilRunning,
} from "../test/stack.ts";

/** Backends in a transaction or running a statement, and the committed rows of `t`. */
const state = Effect.gen(function* () {
  const observer = yield* Observer;
  const rows = yield* observer`select count(*)::int as n from t`;

  return `busy ${yield* busyBackends}, committed ${Number(rows[0]?.n ?? 0)}`;
});

/** Interrupts `transaction` once it is sleeping, and reports the server's state when the interrupt returns and 600 ms later. */
const interruptProbe = (
  design: string,
  transaction: Effect.Effect<unknown, unknown>
) =>
  Effect.gen(function* () {
    const observer = yield* Observer;

    yield* observer`drop table if exists t`;
    yield* observer`create table t (k int primary key)`;

    const fiber = yield* Effect.forkChild(transaction);

    yield* untilRunning("pg_sleep(30)");

    const before = yield* state;

    yield* Fiber.interrupt(fiber);

    const returned = yield* state;

    yield* Effect.sleep("600 millis");

    const later = yield* state;

    yield* Console.log(
      `interrupt ${design}: running ${before}; when interrupt returned ${returned}; 600 ms later ${later}`
    );
  });

const designA = (url: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      pgBouncerLayer(1000, {
        maxConnections: 3,
        url: Redacted.make(url),
      })
    );

    const transaction = Effect.gen(function* () {
      const tx = yield* TxClient;
      const sql = yield* SqlClient.SqlClient;

      return yield* tx.transaction(
        Effect.andThen(sql`insert into t values (1)`, sql`select pg_sleep(30)`)
      );
    }).pipe(Effect.provide(context));

    return { transaction };
  });

const designB = (url: string) =>
  Effect.gen(function* () {
    const database = createDatabase({
      connectionString: url,
      mode: pgBouncer(1000),
    });

    yield* Effect.addFinalizer(() => Effect.promise(() => database.end()));

    // A rejection (the abort's `TransactionAbortedError`) is a defect of a fiber that was interrupted anyway.
    return {
      transaction: Effect.promise((signal) =>
        database.transaction(
          (tx) => tx.query("insert into t values (1); select pg_sleep(30)"),
          { signal }
        )
      ),
    };
  });

const m2b = (
  client: "raw" | "txmode",
  url: string,
  maxPreparedStatements: number
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const run = yield* runScript(
      `${import.meta.dirname}/../test/m2bClient.ts`,
      {
        M2B_CLIENT: client,
        M2B_MAX_PREPARED_STATEMENTS: String(maxPreparedStatements),
        M2B_TRANSACTIONS: "800",
        M2B_URL: url,
      },
      "60 seconds"
    );

    const committed = Option.match(
      Arr.findLast(run.lines, Str.startsWith("committed ")),
      {
        onNone: () => 0,
        onSome: (line) => Number(Str.slice("committed ".length)(line)),
      }
    );

    yield* Console.log(
      `M2b ${client === "raw" ? "PgClient, prepare: true" : "pgBouncerLayer"}, max_prepared_statements=${maxPreparedStatements}: ${committed} of 800 committed, ${run.finished ? "finished" : "HUNG (killed after 60 s)"}, ${(yield* Clock.currentTimeMillis) - started} ms`
    );
  });

const program = Effect.gen(function* () {
  const servers = yield* Servers;

  yield* Console.log(
    "== interruption of a running transaction, behind PgBouncer (transaction mode)"
  );
  yield* interruptProbe(
    "A (this package, @effect/sql-pg)",
    (yield* designA(servers.tracked.endpoint.url)).transaction
  );
  yield* interruptProbe(
    "B (Effect over @pg-txmode/pg, node-postgres)",
    (yield* designB(servers.tracked.endpoint.url)).transaction
  );

  yield* Console.log(
    "== M2b: 800 transactions, eight at a time, three server connections"
  );
  yield* m2b("raw", servers.untracked.endpoint.url, 0);
  yield* m2b("txmode", servers.untracked.endpoint.url, 0);
  yield* m2b("raw", servers.tracked.endpoint.url, 1000);
  yield* m2b("txmode", servers.tracked.endpoint.url, 1000);
}).pipe(Effect.scoped, Effect.provide(Layer.merge(fixture, processes)));

NodeRuntime.runMain(program);
