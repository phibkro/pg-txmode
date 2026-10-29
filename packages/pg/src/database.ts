import { capabilities, requireFeature } from "@pg-txmode/core";
import type {
  Capabilities,
  ConnectionMode,
  DirectMode,
  SessionApi,
  SessionPooledMode,
  TransactionPooledMode,
} from "@pg-txmode/core";
import { Pool } from "pg";
import type { ClientConfig } from "pg";

import { sessionMethods } from "./session.ts";
import type { SessionMethods } from "./session.ts";
import { executorFor } from "./statement.ts";
import type { Param, Row, StatementOptions } from "./statement.ts";
import { runTransaction } from "./transaction.ts";
import type { Transaction, TransactionRunOptions } from "./transaction.ts";

export interface DatabaseOptions<Mode extends ConnectionMode> {
  /** What stands between this client and PostgreSQL. The adapter applies this mode's capabilities; it does not detect it. */
  readonly mode: Mode;
  readonly connectionString: string;
  /**
   * Connections of the driver-level pool. Defaults to 5, because a Worker invocation can hold six simultaneous outgoing
   * connections (https://developers.cloudflare.com/workers/platform/limits/) and Cloudflare's own example sets `max: 5`.
   * Create a database inside the request handler and `end()` it there: a pool in the global scope of a Worker 'will leave
   * you with stale connections' (catalogue row `client-lifecycle`).
   */
  readonly maxConnections?: number;
  /** node-postgres `pipeline`: write queries without waiting for answers. Refused unless the mode supports it. */
  readonly pipeline?: boolean;
  /** Accept a behaviour that is neither documented nor measured for the mode (`unverified`). Off by default. */
  readonly allowUnverified?: boolean;
}

/** What every database offers, whatever the mode. */
export interface TxClient {
  readonly mode: ConnectionMode;
  readonly capabilities: Capabilities;
  /** One statement on a connection of the pool, in autocommit. Use `transaction` for anything that must be atomic. */
  readonly query: (
    text: string,
    values?: readonly Param[],
    options?: StatementOptions
  ) => Promise<readonly Row[]>;
  /** The whole of `body` as one transaction, with the options' isolation level and timeouts, retried as a whole. */
  readonly transaction: <T>(
    body: (tx: Transaction) => Promise<T>,
    options?: TransactionRunOptions
  ) => Promise<T>;
  readonly end: () => Promise<void>;
}

/** A database of the mode `Mode`: session-only methods exist only where the mode keeps the session. */
export type Database<Mode extends ConnectionMode> = [
  SessionApi<Mode, SessionMethods>,
] extends [never]
  ? TxClient
  : TxClient & SessionMethods;

const defaultMaxConnections = 5;

const build = (options: DatabaseOptions<ConnectionMode>): TxClient => {
  const { mode } = options;

  if (options.pipeline === true) {
    requireFeature(mode, "pipelining", {
      allowUnverified: options.allowUnverified === true,
    });
  }

  const config: ClientConfig = {
    connectionString: options.connectionString,
    pipeline: options.pipeline,
  };

  const pool = new Pool({
    ...config,
    max: options.maxConnections ?? defaultMaxConnections,
  });

  const execute = executorFor(mode);

  // An idle connection that the server or the pooler closes is reported on the pool; the next statement opens another.
  pool.on("error", () => {
    // nothing to do: the pool discards the connection
  });

  return {
    capabilities: capabilities(mode),
    end: async () => {
      await pool.end();
    },
    mode,
    query: async (text, values = [], statement = {}) =>
      await execute(pool, text, values, statement),
    transaction: async (body, run = {}) =>
      await runTransaction(pool, execute, body, run),
  };
};

/**
 * A database for a connection mode. A transaction-pooled mode (`hyperdrive`, `pgBouncer(n)`, `supavisor`, `neonPooler`)
 * gets no session-only method at all; a `direct` or `sessionPooled` mode gets `listen` and `withAdvisoryLock`.
 */
export function createDatabase(
  options: DatabaseOptions<TransactionPooledMode>
): TxClient;
export function createDatabase(
  options: DatabaseOptions<DirectMode | SessionPooledMode>
): TxClient & SessionMethods;
export function createDatabase(
  options: DatabaseOptions<ConnectionMode>
): TxClient | (TxClient & SessionMethods) {
  const client = build(options);

  return options.mode.kind === "TransactionPooled"
    ? client
    : {
        ...client,
        ...sessionMethods(options.mode, {
          connectionString: options.connectionString,
        }),
      };
}
