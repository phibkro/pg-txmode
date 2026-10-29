import { neonProfile } from "./profile.ts";
import { pgConnect } from "./session.ts";
import type { Connect } from "./session.ts";
import { startPgBouncer, startPostgres } from "./stack.ts";
import type { Pooler, Postgres } from "./stack.ts";

/** PostgreSQL with a PgBouncer in front of it: what an adapter's tests connect to. */
export interface Stack {
  readonly postgres: Postgres;
  readonly pooler: Pooler;
  /** A client connection to the pooler (node-postgres); an adapter brings its own client and uses `pooler.endpoint`. */
  readonly connect: Connect;
  readonly stop: () => Promise<void>;
}

/** A throwaway PostgreSQL and a PgBouncer (Neon's settings, `poolSize` server connections) on free ports. */
export const startStack = async (poolSize: number): Promise<Stack> => {
  const postgres = await startPostgres();

  const pooler = await startPgBouncer(postgres, {
    ...neonProfile(postgres.maxConnections),
    defaultPoolSize: poolSize,
  });

  return {
    connect: pgConnect(pooler.endpoint.url),
    pooler,
    postgres,
    stop: async () => {
      await pooler.stop();
      await postgres.stop();
    },
  };
};
