import { NodeRuntime } from "@effect/platform-node";
/**
 * The M2b workload as a process of its own, so a hang can be observed and the process killed (an Effect timeout cannot
 * interrupt the hung client: its interruption waits for the very statement that never answers).
 *
 * `bun m2bClient.ts`, configured by M2B_CLIENT (`raw`: PgClient with prepare: true; `txmode`: this package's pgBouncerLayer),
 * M2B_URL (the pooled URL), M2B_MAX_PREPARED_STATEMENTS (what the pooler was started with) and M2B_TRANSACTIONS.
 *
 * Prints `committed <n>` after each commit and `done` when every transaction has ended, whatever the outcome.
 */
import { PgClient } from "@effect/sql-pg";
import { Array as Arr, Config, Console, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";

import { pgBouncerLayer } from "../src/index.ts";

const program = Effect.gen(function* () {
  const kind = yield* Config.String("M2B_CLIENT");
  const url = yield* Config.Redacted("M2B_URL");

  const maxPreparedStatements = yield* Config.Int(
    "M2B_MAX_PREPARED_STATEMENTS"
  );

  const total = yield* Config.Int("M2B_TRANSACTIONS");

  const client =
    kind === "raw"
      ? PgClient.layer({ maxConnections: 5, prepare: true, url })
      : pgBouncerLayer(maxPreparedStatements, { maxConnections: 5, url });

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let committed = 0;

    yield* Effect.forEach(
      Arr.makeBy(total, (index) => index),
      (index) =>
        Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select ${index}::int as a`;
              yield* sql`select ${index}::int + ${1}::int as a`;
              yield* sql`select ${index}::int * ${3}::int as a`;
            })
          )
        ).pipe(
          Effect.flatMap((exit) => {
            if (!Exit.isSuccess(exit)) {
              return Effect.void;
            }

            committed += 1;

            return Console.log(`committed ${committed}`);
          })
        ),
      { concurrency: 8, discard: true }
    );
    yield* Console.log("done");
  }).pipe(Effect.provide(client));
});

NodeRuntime.runMain(Effect.scoped(program));
