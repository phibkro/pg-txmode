import { failureOf } from "@pg-txmode/core";

import type { Connect, Session } from "./session.ts";

/** What one step of a workload ended in: `ok`, or `wrong` (an answer for someone else's SQL). */
type StepResult = "ok" | "wrong";

export interface Tally {
  readonly ok: number;
  readonly wrong: number;
  /** Errors by SQLSTATE, or by message when the driver gave no code. */
  readonly errors: Readonly<Record<string, number>>;
}

const emptyTally: Tally = { errors: {}, ok: 0, wrong: 0 };

/** The SQLSTATE of a driver error, or its message when it has none. */
const errorKey = (error: Error): string =>
  failureOf(error)?.sqlState ?? error.message;

const addResult = (tally: Tally, result: StepResult): Tally =>
  result === "ok"
    ? { ...tally, ok: tally.ok + 1 }
    : { ...tally, wrong: tally.wrong + 1 };

const addError = (tally: Tally, error: Error): Tally => {
  const key = errorKey(error);

  return {
    ...tally,
    errors: { ...tally.errors, [key]: (tally.errors[key] ?? 0) + 1 },
  };
};

export const mergeTallies = (tallies: readonly Tally[]): Tally => {
  const errors = new Map<string, number>();

  for (const tally of tallies) {
    for (const [key, count] of Object.entries(tally.errors)) {
      errors.set(key, (errors.get(key) ?? 0) + count);
    }
  }

  return {
    errors: Object.fromEntries(errors),
    ok: tallies.reduce((sum, tally) => sum + tally.ok, 0),
    wrong: tallies.reduce((sum, tally) => sum + tally.wrong, 0),
  };
};

export const describeTally = (tally: Tally): string =>
  `${tally.ok} ok, ${tally.wrong} wrong answers, errors ${JSON.stringify(tally.errors)}`;

export const failures = (tally: Tally): number =>
  tally.wrong + Object.values(tally.errors).reduce((sum, n) => sum + n, 0);

export type Step = (
  session: Session,
  client: number,
  iteration: number
) => Promise<StepResult>;

/** `iterations` steps of one client, one after another; a step that throws is counted and the client goes on. */
const runClient = async (
  session: Session,
  client: number,
  iterations: number,
  step: Step
): Promise<Tally> => {
  const next = async (iteration: number, tally: Tally): Promise<Tally> => {
    if (iteration >= iterations) {
      return tally;
    }

    try {
      return await next(
        iteration + 1,
        addResult(tally, await step(session, client, iteration))
      );
    } catch (error) {
      // An aborted transaction would fail every later step: leave it first.
      await session.query("ROLLBACK").catch(() => []);

      return await next(
        iteration + 1,
        error instanceof Error ? addError(tally, error) : tally
      );
    }
  };

  return await next(0, emptyTally);
};

/**
 * `clients` connections, each running `iterations` steps one after another, all clients at once. A step that throws is
 * counted by SQLSTATE and the client goes on (after a ROLLBACK, so an aborted transaction does not fail the rest).
 */
export const runClients = async (
  connect: Connect,
  clients: number,
  iterations: number,
  step: Step
): Promise<Tally> =>
  mergeTallies(
    await Promise.all(
      Array.from({ length: clients }, async (_, client) => {
        const session = await connect();

        try {
          return await runClient(session, client, iterations, step);
        } finally {
          await session.end();
        }
      })
    )
  );

/** Runs `step` for each item, one after another. */
export const inSequence = async <T, R>(
  items: readonly T[],
  step: (item: T) => Promise<R>
): Promise<void> => {
  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous;
    await step(item);
  }, Promise.resolve());
};
