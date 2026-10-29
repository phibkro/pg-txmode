import { failureOf } from "./sqlstate.ts";
import type { Failure } from "./sqlstate.ts";

/**
 * How to open a transaction safely behind a transaction pooler, and how to run it again.
 *
 * Every setting is transaction-local (`SET LOCAL`). Cloudflare documents `SET` statements for the duration of a transaction
 * (https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/) without naming `SET LOCAL`, and the harness probe
 * `scoped-set-local` observed it behind PgBouncer. The opening is one
 * simple-query script, so `BEGIN` and the settings cost one round trip (the cost problem of
 * https://github.com/Effect-TS/effect/issues/10113); whether a pooler accepts a multi-statement script is observed by the
 * harness (`pattern-isolation`), and a pooler that does not can run `openingStatements` one by one.
 */

export type IsolationLevel =
  | "read committed"
  | "repeatable read"
  | "serializable";

export interface Timeouts {
  /** `statement_timeout`, in milliseconds. The harness `statement-timeout-vs-cancel` probe shows how it ends. */
  readonly statementMs?: number;
  /** `lock_timeout`, in milliseconds. */
  readonly lockMs?: number;
  /** `idle_in_transaction_session_timeout`, in milliseconds: ends a session that waits inside a transaction. */
  readonly idleInTransactionMs?: number;
  /** `transaction_timeout`, in milliseconds. PostgreSQL 17 and later; an older server refuses the setting. */
  readonly transactionMs?: number;
}

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  readonly timeouts?: Timeouts;
}

/** The setting each timeout sets, with the value the caller gave (undefined: not set). */
const timeoutSettings = (
  timeouts: Timeouts
): readonly (readonly [string, number | undefined])[] => [
  ["idle_in_transaction_session_timeout", timeouts.idleInTransactionMs],
  ["lock_timeout", timeouts.lockMs],
  ["statement_timeout", timeouts.statementMs],
  ["transaction_timeout", timeouts.transactionMs],
];

const isolationSql = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
} as const satisfies Record<IsolationLevel, string>;

export class InvalidTimeoutError extends Error {
  override readonly name = "InvalidTimeoutError";
}

/** The `BEGIN` statement for the options: the isolation level and the access mode go in the statement itself. */
export const beginStatement = (options: TransactionOptions = {}): string => {
  const modes = [
    options.isolation === undefined
      ? []
      : [`ISOLATION LEVEL ${isolationSql[options.isolation]}`],
    options.readOnly === undefined
      ? []
      : [options.readOnly ? "READ ONLY" : "READ WRITE"],
  ].flat();

  return modes.length === 0 ? "BEGIN" : `BEGIN ${modes.join(" ")}`;
};

/**
 * `SET LOCAL` statements for the timeouts. The values are checked to be non-negative safe integers and inlined as digits,
 * so no caller text reaches the SQL; `SET LOCAL` takes no bind parameter.
 */
export const timeoutStatements = (timeouts: Timeouts = {}): readonly string[] =>
  timeoutSettings(timeouts).flatMap(([setting, value]) => {
    if (value === undefined) {
      return [];
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidTimeoutError(
        `${setting} must be a non-negative integer of milliseconds, got ${value}`
      );
    }

    return [`SET LOCAL ${setting} = ${value}`];
  });

/** The statements that open a transaction, in order. */
export const openingStatements = (
  options: TransactionOptions = {}
): readonly string[] => [
  beginStatement(options),
  ...timeoutStatements(options.timeouts),
];

/** The opening as one script for the simple query protocol: one round trip. */
export const openingScript = (options: TransactionOptions = {}): string =>
  `${openingStatements(options).join("; ")};`;

export interface RetryPolicy {
  /** Attempts in total, the first included. At least 1. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Retry a deadlock (40P01). A deadlock can be a persistent bug, so it is the one the caller may turn off. */
  readonly retryDeadlocks: boolean;
}

/** 40001 always, 40P01 bounded; the rule is https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html. */
export const defaultRetryPolicy: RetryPolicy = {
  baseDelayMs: 10,
  maxAttempts: 5,
  maxDelayMs: 500,
  retryDeadlocks: true,
};

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
}

/** Full-jitter exponential backoff: a uniform draw in `[0, min(maxDelay, base * 2^(attempt-1))]`. `random` is in `[0, 1)`. */
export const backoffMs = (
  policy: RetryPolicy,
  attempt: number,
  random: number
): number =>
  Math.floor(
    random *
      Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  );

/** Whether to run the whole transaction again after `attempt` attempts ended in `failure`. Pure. */
export const retryDecision = (
  failure: Failure,
  attempt: number,
  policy: RetryPolicy,
  random: number
): RetryDecision => {
  const allowed =
    failure.retry === "whole-transaction" &&
    attempt < policy.maxAttempts &&
    (failure.kind !== "deadlock-detected" || policy.retryDeadlocks);

  return {
    delayMs: allowed ? backoffMs(policy, attempt, random) : 0,
    retry: allowed,
  };
};

export interface RetryEnvironment {
  readonly policy?: RetryPolicy;
  /** Waits; defaults to a timer. Inject a fake to test without time. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** A draw in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Called before each retry; the failure and the attempt that ended in it. */
  readonly onRetry?: (failure: Failure, attempt: number) => void;
}

const delay = async (milliseconds: number): Promise<null> => {
  const { promise, resolve } = Promise.withResolvers<null>();

  setTimeout(() => {
    resolve(null);
  }, milliseconds);

  return await promise;
};

const timer = async (milliseconds: number): Promise<void> => {
  await delay(milliseconds);
};

interface NextAttempt {
  readonly failure: Failure;
  readonly delayMs: number;
}

/** What to do after `error` ended attempt number `number`: undefined when it is not a retryable SQL failure. */
const retryAfter = (
  error: Error,
  number: number,
  environment: RetryEnvironment
): NextAttempt | undefined => {
  const failure = failureOf(error);

  if (failure === undefined) {
    return undefined;
  }

  const decision = retryDecision(
    failure,
    number,
    environment.policy ?? defaultRetryPolicy,
    (environment.random ?? Math.random)()
  );

  return decision.retry ? { delayMs: decision.delayMs, failure } : undefined;
};

/**
 * Runs `attempt` until it succeeds or fails with something that is not retryable. `attempt` MUST be the whole
 * transaction (open, every statement, commit, and the code that decides which statements to run), and its side effects
 * outside the database MUST wait until it returned: the whole transaction can run more than once. The last failure is
 * thrown unchanged.
 */
export const withTransactionRetry = async <T>(
  attempt: (number: number) => Promise<T>,
  environment: RetryEnvironment = {}
): Promise<T> => {
  const run = async (number: number): Promise<T> => {
    try {
      return await attempt(number);
    } catch (error) {
      const next =
        error instanceof Error
          ? retryAfter(error, number, environment)
          : undefined;

      if (next === undefined) {
        throw error;
      }

      environment.onRetry?.(next.failure, number);
      await (environment.sleep ?? timer)(next.delayMs);

      return await run(number + 1);
    }
  };

  return await run(1);
};
