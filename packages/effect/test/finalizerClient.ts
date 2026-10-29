/**
 * The pool finalizer hang (Effect-TS/effect#10128) as a process of its own, so the hang can be observed and the process
 * killed.
 *
 * `bun finalizerClient.ts`, configured by FINALIZER_CLIENT and FINALIZER_URL (a PostgreSQL):
 *
 * - `make`: `PgClient.make` built in the scope directly, as the issue's reproduction does;
 * - `layer`: `PgClient.layer` built into the scope;
 * - `txmode`: this package's `directLayer` built into the scope.
 *
 * The client's idle connection is retired after 300 ms. A finalizer registered after the client, in the same scope,
 * queries the client: `Scope.close` waits for it. Prints `finalizer query ok` when that query returned and `closed` when
 * the scope closed.
 */
import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { Config, Console, Context, Effect, Exit, Layer, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";

import { directLayer } from "../src/index.ts";

const program = Effect.gen(function* () {
  const kind = yield* Config.String("FINALIZER_CLIENT");
  const url = yield* Config.Redacted("FINALIZER_URL");
  const scope = yield* Scope.make();

  const settings = {
    idleTimeout: "300 millis",
    maxConnections: 2,
    url,
  } as const;

  const sql =
    kind === "make"
      ? yield* PgClient.make(settings).pipe(
          Scope.provide(scope),
          Effect.provide(Reactivity.layer)
        )
      : Context.get(
          yield* Layer.buildWithScope(
            kind === "layer" ? PgClient.layer(settings) : directLayer(settings),
            scope
          ),
          SqlClient.SqlClient
        );

  yield* Scope.addFinalizer(
    scope,
    sql`select 1 as release`.pipe(
      Effect.andThen(Console.log("finalizer query ok")),
      Effect.orDie
    )
  );

  yield* sql`select 1 as first`;
  yield* Effect.sleep("1500 millis");
  yield* Scope.close(scope, Exit.void);
  yield* Console.log("closed");
});

NodeRuntime.runMain(program);
