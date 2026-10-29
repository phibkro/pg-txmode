import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, Layer, Option, String as Str } from "effect";

import { processes, runScript } from "./process.ts";
import { Servers } from "./stack.ts";

/**
 * KNOWN ISSUES of `@effect/sql-pg` 4.1.0, each observed from outside the client that has it. When the first test of a block
 * starts to fail, the defect has gone (a new `@effect/sql-pg`, PgBouncer or Effect): update the catalogue row, retire the
 * workaround and delete the pin in the same change.
 */

const total = 400;

const committed = (lines: readonly string[]): number =>
  Option.getOrElse(
    Option.map(Arr.findLast(lines, Str.startsWith("committed ")), (line) =>
      Number(Str.slice("committed ".length)(line))
    ),
    () => 0
  );

const m2b = (
  client: "raw" | "txmode",
  url: string,
  maxPreparedStatements: number
) =>
  runScript(
    "test/m2bClient.ts",
    {
      M2B_CLIENT: client,
      M2B_MAX_PREPARED_STATEMENTS: String(maxPreparedStatements),
      M2B_TRANSACTIONS: String(total),
      M2B_URL: url,
    },
    "20 seconds"
  );

const finalizer = (client: "make" | "layer" | "txmode") =>
  Effect.gen(function* () {
    const servers = yield* Servers;

    return yield* runScript(
      "test/finalizerClient.ts",
      {
        FINALIZER_CLIENT: client,
        FINALIZER_URL: servers.postgres.endpoint.url,
      },
      "10 seconds"
    );
  });

/**
 * Catalogue row `named-statements-untracked` (research report M2b).
 *
 * `PgClient` with its default `prepare: true` behind PgBouncer with `max_prepared_statements = 0` loses its named
 * statements: 26000 (the statement does not exist) fails transactions, and the last ones never complete (800 transactions,
 * eight at a time, three server connections: `docs/evidence/effect/designs.txt` has the raw runs; the research report measured
 * the same on 4.0.6; reported upstream as Effect-TS/effect#10151). This package's layer derives `prepare` from the mode, so the same workload completes there.
 * The workload runs in a process of its own (`m2bClient.ts`).
 */
layer(Layer.mergeAll(Servers.layer, processes), {
  excludeTestServices: true,
  timeout: "120 seconds",
})("M2b", (it) => {
  it.effect(
    "KNOWN ISSUE: PgClient with prepare: true behind max_prepared_statements = 0 fails or hangs",
    () =>
      Effect.gen(function* () {
        const servers = yield* Servers;
        const run = yield* m2b("raw", servers.untracked.endpoint.url, 0);

        assert.isTrue(!run.finished || committed(run.lines) < total);
      })
  );

  it.effect(
    "control: the same client and workload behind max_prepared_statements = 1000 completes",
    () =>
      Effect.gen(function* () {
        const servers = yield* Servers;
        const run = yield* m2b("raw", servers.tracked.endpoint.url, 1000);

        assert.isTrue(run.finished);
        assert.strictEqual(committed(run.lines), total);
      })
  );

  it.effect(
    "the layer for pgBouncer(0) sends unnamed statements, and the same workload completes",
    () =>
      Effect.gen(function* () {
        const servers = yield* Servers;
        const run = yield* m2b("txmode", servers.untracked.endpoint.url, 0);

        assert.isTrue(run.finished);
        assert.strictEqual(committed(run.lines), total);
      })
  );
});

/**
 * Effect-TS/effect#10128: a finalizer that queries a pooled client built in its own scope hangs `Scope.close` once the pool
 * has retired its idle connection. It happens when the client is built with `PgClient.make` in the scope itself; a client
 * that a layer builds lives in a scope of the layer, which closes after the finalizers registered later, so the query
 * returns. This package only builds clients in layers, so it needs no workaround.
 *
 * Fixed upstream on Effect main in PR #10129 (the pool runs in a child scope); not in 4.1.0. Flip this pin (the `make` run
 * then closes) when the fixed `effect` version is the minimum peer of this package.
 */
layer(Layer.mergeAll(Servers.layer, processes), {
  excludeTestServices: true,
  timeout: "120 seconds",
})("pool finalizer", (it) => {
  it.effect(
    "KNOWN ISSUE: PgClient.make in the scope of a finalizer that queries it never closes the scope",
    () =>
      Effect.gen(function* () {
        const run = yield* finalizer("make");

        assert.isFalse(run.finished, Arr.join(run.lines, " | "));
        assert.deepStrictEqual(run.lines, []);
      })
  );

  it.effect.each(["layer", "txmode"] as const)(
    "control, %s: built by a layer, the finalizer's query returns and the scope closes",
    (client) =>
      Effect.gen(function* () {
        const run = yield* finalizer(client);

        assert.isTrue(run.finished);
        assert.deepStrictEqual(run.lines, ["finalizer query ok", "closed"]);
      })
  );
});
