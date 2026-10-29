import type { Outcome } from "@pg-txmode/core";

import type { Connect, Session } from "./session.ts";
import type { Endpoint } from "./stack.ts";

/** What a probe connects to: the pooler under test, or PostgreSQL itself as the control. */
export interface Target {
  /** Opens a client connection to the target. */
  readonly connect: Connect;
  readonly endpoint: Endpoint;
  /** PostgreSQL itself, for an observer that must not pass through the pooler. */
  readonly direct: Endpoint;
}

export interface Observation {
  readonly outcome: Outcome;
  /** What was seen, with the counts: this is the raw output that the catalogue's notes rest on. */
  readonly detail: string;
}

/**
 * One measurement of the catalogue. A probe runs against the pooler and against PostgreSQL, and its observation is
 * compared to the catalogue row that names it (`packages/harness/test/matrix.test.ts`).
 */
export interface Probe {
  readonly id: string;
  /** PgBouncer's `default_pool_size` for this probe: 1 makes two clients share one server connection. */
  readonly poolSize: number;
  /** PgBouncer's `max_prepared_statements`. */
  readonly maxPreparedStatements: number;
  readonly run: (target: Target) => Promise<Observation>;
}

export const works = (detail: string): Observation => ({
  detail,
  outcome: "works",
});

export const leaks = (detail: string): Observation => ({
  detail,
  outcome: "leaks",
});

export const breaks = (detail: string): Observation => ({
  detail,
  outcome: "breaks",
});

/** Runs `use` with the sessions it opens and closes every one, whether `use` returns or throws. */
export const withSessions = async <T>(
  connect: Connect,
  count: number,
  use: (sessions: readonly Session[]) => Promise<T>
): Promise<T> => {
  const sessions = await Promise.all(
    Array.from({ length: count }, async () => await connect())
  );

  try {
    return await use(sessions);
  } finally {
    await Promise.allSettled(
      sessions.map(async (session) => {
        await session.end();
      })
    );
  }
};

/** Two clients at once, for a probe where one client acts and the other looks. */
export const withPair = async (
  connect: Connect,
  use: (a: Session, b: Session) => Promise<Observation>
): Promise<Observation> =>
  await withSessions(connect, 2, async ([a, b]) =>
    a === undefined || b === undefined
      ? await Promise.resolve(
          breaks("the harness opened fewer than two sessions")
        )
      : await use(a, b)
  );
