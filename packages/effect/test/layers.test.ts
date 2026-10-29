import { assert, describe, it, layer as sharedLayer } from "@effect/vitest";
import {
  capabilities,
  direct,
  hyperdrive,
  neonPooler,
  pgBouncer,
  sessionPooled,
  supavisor,
} from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
  describe as typeDescribe,
  expect,
  expectTypeOf,
  test,
} from "vite-plus/test";

import {
  directLayer,
  hyperdriveLayer,
  layer,
  ModeRefusedError,
  neonLayer,
  pgBouncerLayer,
  sessionPooledLayer,
  supavisorLayer,
  TxClient,
  TxSession,
} from "../src/index.ts";
import type { LayerError } from "../src/index.ts";
import { Servers } from "./stack.ts";

/** A server that nothing listens on: a layer that builds against it did no network work. */
const nowhere = { url: Redacted.make("postgres://app@127.0.0.1:1/app") };

const modes = [
  ["hyperdrive", hyperdrive],
  ["pgBouncer(0)", pgBouncer(0)],
  ["pgBouncer(1000)", pgBouncer(1000)],
  ["supavisor", supavisor],
  ["neon", neonPooler],
  ["direct", direct],
  ["sessionPooled", sessionPooled],
] as const;

const layerOf = (mode: ConnectionMode): Layer.Layer<TxClient, LayerError> =>
  mode.kind === "TransactionPooled"
    ? layer(mode, nowhere)
    : layer(mode, nowhere);

describe("construction", () => {
  it.effect.each(modes)(
    "%s: building the layer connects to nothing, and the TxClient reports the core's capabilities",
    ([, mode]) =>
      Effect.gen(function* () {
        const tx = yield* TxClient;

        assert.deepStrictEqual(tx.capabilities, capabilities(mode));
        assert.deepStrictEqual(tx.mode, mode);
      }).pipe(Effect.provide(layerOf(mode)))
  );

  test("constructing a layer does no work: the value is built and discarded with no server and no error", () => {
    expect(() => [
      hyperdriveLayer(nowhere),
      pgBouncerLayer(0, nowhere),
      supavisorLayer(nowhere),
      neonLayer(nowhere),
      directLayer(nowhere),
      sessionPooledLayer(nowhere),
    ]).not.toThrow();
  });

  it.effect(
    "only the SqlClient is exposed by a pooled layer, never the PgClient with its listen",
    () =>
      Effect.gen(function* () {
        assert.isTrue(
          Option.isSome(yield* Effect.serviceOption(SqlClient.SqlClient))
        );
        assert.isTrue(Option.isSome(yield* Effect.serviceOption(TxClient)));
        assert.isTrue(Option.isNone(yield* Effect.serviceOption(TxSession)));
      }).pipe(Effect.provide(supavisorLayer(nowhere)))
  );

  it.effect("a direct layer also provides the session methods", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isSome(yield* Effect.serviceOption(TxSession)));
    }).pipe(Effect.provide(directLayer(nowhere)))
  );
});

const refusal = (build: Layer.Layer<TxClient, LayerError>) =>
  Effect.flip(Layer.build(build).pipe(Effect.scoped));

describe("a request that the mode cannot honour is refused when the layer is built", () => {
  it.effect.each([
    ["pgBouncer(0)", pgBouncerLayer(0, { ...nowhere, prepare: true })],
    ["supavisor", supavisorLayer({ ...nowhere, prepare: true })],
  ] as const)(
    "%s: prepare: true is the M2b hang, refused with the catalogue row",
    ([, build]) =>
      Effect.gen(function* () {
        const error = yield* refusal(build);

        assert.instanceOf(error, ModeRefusedError);
        assert.strictEqual(error.row, "named-statements-untracked");
        assert.match(
          error.message,
          /catalogue row named-statements-untracked/u
        );
      })
  );

  it.effect.each([
    ["pgBouncer(1000)", pgBouncerLayer(1000, { ...nowhere, prepare: true })],
    ["hyperdrive", hyperdriveLayer({ ...nowhere, prepare: true })],
    [
      "pgBouncer(0), prepare: false",
      pgBouncerLayer(0, { ...nowhere, prepare: false }),
    ],
  ] as const)("control, %s: the same request is accepted", ([, build]) =>
    Layer.build(build).pipe(Effect.scoped, Effect.asVoid)
  );

  it.effect.each([
    ["supavisor", supavisorLayer({ ...nowhere, multiplex: true }), "no"],
    [
      "hyperdrive",
      hyperdriveLayer({ ...nowhere, multiplex: true }),
      "unverified",
    ],
  ] as const)(
    "%s: multiplex is refused where the catalogue says %s",
    ([, build, support]) =>
      Effect.gen(function* () {
        const error = yield* refusal(build);

        assert.instanceOf(error, ModeRefusedError);
        assert.strictEqual(error.row, "pipelining");
        assert.strictEqual(error.support, support);
      })
  );

  it.effect(
    "control: multiplex is accepted where it was measured, and where the caller accepts the risk",
    () =>
      Effect.gen(function* () {
        yield* Layer.build(
          pgBouncerLayer(1000, { ...nowhere, multiplex: true })
        ).pipe(Effect.scoped);
        yield* Layer.build(
          hyperdriveLayer({
            ...nowhere,
            allowUnverified: true,
            multiplex: true,
          })
        ).pipe(Effect.scoped);
      })
  );
});

const preparedCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`select 1 as one`;
  yield* sql`select 2 as two`;

  const rows =
    yield* sql`select count(*)::int as n from pg_prepared_statements`;

  return Number(rows[0]?.n);
});

sharedLayer(Servers.layer, {
  excludeTestServices: true,
  timeout: "60 seconds",
})("prepare comes from the mode's capabilities", (shared) => {
  shared.effect(
    "a direct connection keeps named statements; `prepare: false` sends none",
    () =>
      Effect.gen(function* () {
        const servers = yield* Servers;
        const url = Redacted.make(servers.postgres.endpoint.url);

        const named = yield* preparedCount.pipe(
          Effect.provide(directLayer({ maxConnections: 1, url }))
        );

        const unnamed = yield* preparedCount.pipe(
          Effect.provide(
            directLayer({ maxConnections: 1, prepare: false, url })
          )
        );

        assert.isAbove(named, 0);
        assert.strictEqual(unnamed, 0);
      })
  );

  shared.effect(
    "behind a pooler that does not track names the layer sends none, without being told",
    () =>
      Effect.gen(function* () {
        const servers = yield* Servers;

        const count = yield* preparedCount.pipe(
          Effect.provide(
            pgBouncerLayer(0, {
              maxConnections: 1,
              url: Redacted.make(servers.untracked.endpoint.url),
            })
          )
        );

        assert.strictEqual(count, 0);
      })
  );
});

typeDescribe("the capability is in the type", () => {
  const needsSession = TxSession;

  test("a pooled layer provides no TxSession; a direct or session-pooled one does", () => {
    expectTypeOf(hyperdriveLayer(nowhere)).toEqualTypeOf<
      Layer.Layer<TxClient | SqlClient.SqlClient, LayerError>
    >();
    expectTypeOf(pgBouncerLayer(0, nowhere)).toEqualTypeOf<
      Layer.Layer<TxClient | SqlClient.SqlClient, LayerError>
    >();
    expectTypeOf(directLayer(nowhere)).toEqualTypeOf<
      Layer.Layer<TxClient | SqlClient.SqlClient | TxSession, LayerError>
    >();
    expectTypeOf(sessionPooledLayer(nowhere)).toEqualTypeOf<
      Layer.Layer<TxClient | SqlClient.SqlClient | TxSession, LayerError>
    >();
  });

  test("a program that listens or takes a session lock is not satisfied by a pooled layer", () => {
    const pooled = Effect.provide(needsSession, hyperdriveLayer(nowhere));
    const session = Effect.provide(needsSession, directLayer(nowhere));

    // The requirement stays, and nothing can run the program until a TxSession is provided (`runPromise` wants `never`).
    expectTypeOf<Effect.Services<typeof pooled>>().toEqualTypeOf<TxSession>();
    expectTypeOf<Effect.Services<typeof session>>().toEqualTypeOf<never>();
    expectTypeOf<Effect.Error<typeof session>>().toEqualTypeOf<LayerError>();
  });

  test("the transaction keeps the body's requirement and adds only the refusals", () => {
    class Clock extends Context.Service<Clock, { readonly now: number }>()(
      "test/Clock"
    ) {}

    const body = Effect.gen(function* () {
      return (yield* Clock).now;
    });

    const run = Effect.gen(function* () {
      return yield* (yield* TxClient).transaction(body);
    });

    expectTypeOf<Effect.Services<typeof run>>().toEqualTypeOf<
      Clock | TxClient
    >();
    expectTypeOf<Effect.Success<typeof run>>().toEqualTypeOf<number>();
    expectTypeOf<
      Extract<Effect.Error<typeof run>, SqlError>
    >().toEqualTypeOf<SqlError>();
  });
});
