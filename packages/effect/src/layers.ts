import {
  direct,
  hyperdrive,
  neonPooler,
  pgBouncer,
  sessionPooled,
  supavisor,
} from "@pg-txmode/core";
import type {
  ConnectionMode,
  DirectMode,
  SessionPooledMode,
  TransactionPooledMode,
} from "@pg-txmode/core";
import { Context, Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { makePgClient } from "./client.ts";
import type { SessionPgConfig, TxPgConfig } from "./client.ts";
import type { ModeRefusedError } from "./errors.ts";
import { makeTxSession, TxSession } from "./session.ts";
import { makeTxClient, TxClient } from "./txClient.ts";

/** What a layer fails with at construction: the driver's `SqlError`, or the mode's refusal of the configuration. */
export type LayerError = SqlError | ModeRefusedError;

/**
 * The client of `mode` and the services every mode has. It is provided under the `SqlClient` tag, never the `PgClient` tag:
 * the type has no `listen` or `notify`, which a pooled mode must not offer. The value is the driver's object and still
 * has them at run time; only the type keeps a program from reaching them.
 */
const built = (mode: ConnectionMode, config: TxPgConfig) =>
  Effect.gen(function* () {
    const client = yield* makePgClient(mode, config);

    return {
      client,
      context: Context.make(SqlClient.SqlClient, client).pipe(
        Context.add(
          TxClient,
          makeTxClient(mode, client, {
            allowUnverified: config.allowUnverified,
          })
        )
      ),
    };
  });

const pooledLayer = (
  mode: TransactionPooledMode,
  config: TxPgConfig
): Layer.Layer<TxClient | SqlClient.SqlClient, LayerError> =>
  Layer.effectContext(
    Effect.map(built(mode, config), ({ context }) => context)
  ).pipe(Layer.provide(Reactivity.layer));

const defaultSessionConnections = 2;
const defaultSessionAcquireTimeout = "10 seconds";

/**
 * The session services come from a second client with a pool of its own: a lock (or a `listen`) holds its connection for
 * as long as it lives, and on the main pool that many connections fewer would be left for the bodies that run under them.
 * Its statements are unnamed (`prepare: false`), which every mode allows.
 */
const sessionLayer = (
  mode: DirectMode | SessionPooledMode,
  config: SessionPgConfig
): Layer.Layer<TxClient | SqlClient.SqlClient | TxSession, LayerError> => {
  const { sessionConnections, ...clientConfig } = config;

  return Layer.effectContext(
    Effect.gen(function* () {
      const { context } = yield* built(mode, clientConfig);

      const holders = yield* makePgClient(mode, {
        ...clientConfig,
        acquireTimeout:
          clientConfig.acquireTimeout ?? defaultSessionAcquireTimeout,
        maxConnections: sessionConnections ?? defaultSessionConnections,
        multiplex: false,
        prepare: false,
      });

      return Context.add(context, TxSession, makeTxSession(holders));
    })
  ).pipe(Layer.provide(Reactivity.layer));
};

/**
 * A `SqlClient` and a `TxClient` for a connection mode, built on `@effect/sql-pg`'s `PgClient` with the configuration the
 * mode's capabilities decide. A transaction-pooled mode provides no `TxSession`, so a program that listens or takes a
 * session advisory lock does not compile against it; `direct` and `sessionPooled` provide it.
 *
 * Nothing runs until the layer is built; the client's pool is owned by the layer's scope and closed with it.
 */
export function layer(
  mode: TransactionPooledMode,
  config: TxPgConfig
): Layer.Layer<TxClient | SqlClient.SqlClient, LayerError>;
export function layer(
  mode: DirectMode | SessionPooledMode,
  config: SessionPgConfig
): Layer.Layer<TxClient | SqlClient.SqlClient | TxSession, LayerError>;
export function layer(
  mode: ConnectionMode,
  config: SessionPgConfig
):
  | Layer.Layer<TxClient | SqlClient.SqlClient, LayerError>
  | Layer.Layer<TxClient | SqlClient.SqlClient | TxSession, LayerError> {
  return mode.kind === "TransactionPooled"
    ? pooledLayer(mode, config)
    : sessionLayer(mode, config);
}

/** Cloudflare Hyperdrive. */
export const hyperdriveLayer = (config: TxPgConfig) =>
  layer(hyperdrive, config);

/** PgBouncer in transaction mode; `maxPreparedStatements` is its `max_prepared_statements` (0: names are not tracked). */
export const pgBouncerLayer = (
  maxPreparedStatements: number,
  config: TxPgConfig
) => layer(pgBouncer(maxPreparedStatements), config);

/** Supabase's shared pooler (Supavisor, transaction mode). */
export const supavisorLayer = (config: TxPgConfig) => layer(supavisor, config);

/** Neon's pooler (PgBouncer with `max_prepared_statements = 1000`). */
export const neonLayer = (config: TxPgConfig) => layer(neonPooler, config);

/** A direct connection to PostgreSQL. */
export const directLayer = (config: SessionPgConfig) => layer(direct, config);

/** A pooler that keeps one server connection per client session (PgBouncer `pool_mode = session`). */
export const sessionPooledLayer = (config: SessionPgConfig) =>
  layer(sessionPooled, config);
