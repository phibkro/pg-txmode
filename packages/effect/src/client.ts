import { PgClient } from "@effect/sql-pg";
import type { PgPoolConfig } from "@effect/sql-pg/PgClient";
import { capabilities } from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";
import { Effect } from "effect";
import type { Scope } from "effect";
import type { Reactivity } from "effect/reactivity";
import type { SqlError } from "effect/sql/SqlError";

import type { ModeRefusedError } from "./errors.ts";
import { requireModeFeature, requireNamedStatements } from "./refusal.ts";

/**
 * The configuration of `PgClient.layer` that a mode decides is not here: `prepare` and `multiplex` come from the mode's
 * capabilities. Both can still be asked for, and a request the mode cannot honour is refused at construction.
 */
export interface TxPgConfig extends Omit<
  PgPoolConfig,
  "multiplex" | "prepare"
> {
  /**
   * Send named prepared statements. Defaults to what the mode tracks (`capabilities(mode).preparedStatements`); `false` is
   * always allowed, and `true` is refused where the pooler does not track names (the M2b hang of `@effect/sql-pg`).
   */
  readonly prepare?: boolean;
  /** Pipeline queries from several fibers on one connection. Refused unless the mode's `pipelining` is `yes`. */
  readonly multiplex?: boolean;
  /** Accept a behaviour that is neither documented nor measured for the mode (`unverified`). Off by default. */
  readonly allowUnverified?: boolean;
}

/**
 * What `directLayer` and `sessionPooledLayer` add: the connections that hold a session (a `listen` and the lock of
 * `withAdvisoryLock`) come from a pool of their own, so a body that runs under a lock still has the main pool.
 */
export interface SessionPgConfig extends TxPgConfig {
  /**
   * Connections of the session pool: at most this many `listen` calls and `withAdvisoryLock` bodies at a time. Defaults to 2.
   * A call beyond it waits for a connection for `acquireTimeout` (10 seconds when the config has none) and then fails with
   * the driver's `SqlError`; it never waits for ever.
   */
  readonly sessionConnections?: number;
}

/** A Worker invocation can hold six simultaneous outgoing connections; the pool stays below that (spec 0002). */
const defaultMaxConnections = 5;

/**
 * The `PgClient` for `mode`, owned by the scope it is built in: its pool closes with that scope. The layers build it in
 * the scope of the layer, so a finalizer registered later in the caller's scope runs first and can still query it
 * (Effect-TS/effect#10128 needs the client built in the finalizer's own scope; see `test/knownIssues.test.ts`).
 */
export const makePgClient = (
  mode: ConnectionMode,
  config: TxPgConfig
): Effect.Effect<
  PgClient.PgClient,
  SqlError | ModeRefusedError,
  Scope.Scope | Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    const { allowUnverified, multiplex, prepare, ...rest } = config;

    if (prepare === true) {
      yield* requireNamedStatements(mode);
    }

    if (multiplex === true) {
      yield* requireModeFeature(mode, "pipelining", allowUnverified === true);
    }

    return yield* PgClient.make({
      maxConnections: defaultMaxConnections,
      ...rest,
      multiplex: multiplex === true,
      prepare:
        prepare ?? capabilities(mode).preparedStatements === "named-protocol",
    });
  });
