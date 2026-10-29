import { afterAll, beforeAll } from "vite-plus/test";

import { pgConnect, startPgBouncer, startPostgres } from "../src/index.ts";
import type { Connect, Pooler, Postgres, Session } from "../src/index.ts";
import type { Target } from "../src/probe.ts";
import { withSessions } from "../src/probe.ts";
import { neonProfile } from "../src/profile.ts";

/** A throwaway PostgreSQL for the tests of one file, started before them and stopped after them. */
export const usePostgres = (): (() => Postgres) => {
  let postgres: Postgres | undefined;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 60_000);
  afterAll(async () => {
    await postgres?.stop();
  });

  return () => {
    if (postgres === undefined) {
      throw new Error("the test PostgreSQL is not running");
    }

    return postgres;
  };
};

export interface Stack {
  readonly postgres: Postgres;
  readonly pooler: Pooler;
  /** A connection to the pooler. */
  readonly connect: Connect;
}

/** PostgreSQL and a PgBouncer in front of it (Neon's settings, `poolSize` server connections), for the tests of one file. */
export const useStack = (poolSize: number): (() => Stack) => {
  let stack: Stack | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();

    const pooler = await startPgBouncer(postgres, {
      ...neonProfile(postgres.maxConnections),
      defaultPoolSize: poolSize,
    });

    stack = { connect: pgConnect(pooler.endpoint.url), pooler, postgres };
  }, 60_000);
  afterAll(async () => {
    await stack?.pooler.stop();
    await stack?.postgres.stop();
  });

  return () => {
    if (stack === undefined) {
      throw new Error("the test stack is not running");
    }

    return stack;
  };
};

/** Two sessions, or a failure of the test when the harness cannot open them. */
export const withTwo = async <T>(
  connect: Connect,
  use: (a: Session, b: Session) => Promise<T>
): Promise<T> =>
  await withSessions(connect, 2, async ([a, b]) =>
    a === undefined || b === undefined
      ? await Promise.reject(new Error("no sessions"))
      : await use(a, b)
  );

export const one = async (
  session: Session,
  sql: string,
  values: readonly (string | number)[] = []
) => (await session.query(sql, values))[0];

/** The stack as a probe target: connect to the pooler, with PostgreSQL itself behind it. */
export const targetOf = (stack: Stack): Target => ({
  connect: stack.connect,
  direct: stack.postgres.endpoint,
  endpoint: stack.pooler.endpoint,
});

/** Runs one statement on a session of its own, to set a test up. */
export const seed = async (connect: Connect, sql: string): Promise<void> => {
  await withSessions(connect, 1, async ([session]) => {
    await session?.query(sql);
  });
};
