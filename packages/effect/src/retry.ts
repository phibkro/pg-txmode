import { defaultRetryPolicy, failureOf, retryDecision } from "@pg-txmode/core";
import type { Failure, RetryDecision, RetryPolicy } from "@pg-txmode/core";
import { Cause, Duration, Effect, Predicate, Random, Schedule } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The core's failure for an Effect SQL error: the SQLSTATE and message of the driver's error, read from the `cause` of the
 * error's reason. `undefined` for an `SqlError` that carries no SQLSTATE (a failure of the client). The SQLSTATE policy itself (`classifyFailure`) is the core's, so it exists once.
 */
export const failureOfSqlError = (error: SqlError): Failure | undefined => {
  const { cause } = error.reason;

  return failureOf({
    code:
      Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
        ? cause.code
        : undefined,
    message:
      Predicate.hasProperty(cause, "message") &&
      Predicate.isString(cause.message)
        ? cause.message
        : undefined,
  });
};

const stop: RetryDecision = { delayMs: 0, retry: false };

/** One step of the schedule: the decision and the time to wait before the next run. */
const wait = (decision: RetryDecision): [RetryDecision, Duration.Duration] => [
  decision,
  Duration.millis(decision.delayMs),
];

/**
 * A `Schedule` that decides, from the failure of a whole transaction, whether to run it again and after how long. The
 * decision is the core's `retryDecision` (40001 always, 40P01 while the policy allows, bounded by `maxAttempts`, full-jitter
 * backoff); the draw comes from Effect's `Random`, so a test controls it. The schedule ends with the last decision when the
 * failure is not retryable, so `Effect.retry` fails with the last error unchanged.
 */
export const transactionRetrySchedule = (
  policy: RetryPolicy = defaultRetryPolicy
): Schedule.Schedule<RetryDecision> =>
  Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const failure = isSqlError(meta.input)
        ? failureOfSqlError(meta.input)
        : undefined;

      return failure === undefined
        ? Cause.done(stop)
        : Effect.flatMap(Random.next, (random) => {
            const decision = retryDecision(
              failure,
              meta.attempt,
              policy,
              random
            );

            return decision.retry
              ? Effect.succeed(wait(decision))
              : Cause.done(decision);
          });
    })
  );
