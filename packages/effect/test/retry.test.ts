import { assert, describe, it } from "@effect/vitest";
import {
  backoffMs,
  classifyFailure,
  defaultRetryPolicy,
} from "@pg-txmode/core";
import type { RetryPolicy } from "@pg-txmode/core";
import { Array as Arr, Clock, Effect, Fiber } from "effect";
import {
  DeadlockError,
  SerializationError,
  SqlError,
  UnknownError,
  UniqueViolation,
} from "effect/sql/SqlError";
import { TestClock } from "effect/testing";

import { failureOfSqlError, transactionRetrySchedule } from "../src/index.ts";

/**
 * The retry schedule is the core's decision (`retryDecision`) driven by Effect's clock and `Random`: the same SQLSTATE
 * policy, the same bounds, nothing of its own. No server is needed; the failures are the errors that `@effect/sql-pg`
 * raises, built by hand.
 */

const props = (code: string) => ({
  cause: { code, message: `error ${code}` },
  message: `error ${code}`,
  operation: "execute",
});

const sqlError = (code: string): SqlError => {
  switch (code) {
    case "40001": {
      return new SqlError({ reason: new SerializationError(props(code)) });
    }

    case "40P01": {
      return new SqlError({ reason: new DeadlockError(props(code)) });
    }

    case "23505": {
      return new SqlError({
        reason: new UniqueViolation({ ...props(code), constraint: "k" }),
      });
    }

    default: {
      return new SqlError({ reason: new UnknownError(props(code)) });
    }
  }
};

describe("failureOfSqlError", () => {
  it.each([
    "40001",
    "40P01",
    "23505",
    "57014",
    "25P02",
    "58000",
    "08006",
    "XX000",
  ])("%s is the core's classification of the SQLSTATE", (code) => {
    assert.deepStrictEqual(
      failureOfSqlError(sqlError(code)),
      classifyFailure({ message: `error ${code}`, sqlState: code })
    );
  });

  it("is undefined for an SqlError that carries no SQLSTATE: a failure of the client", () => {
    assert.isUndefined(
      failureOfSqlError(
        new SqlError({
          reason: new UnknownError({
            cause: new Error("no code"),
            message: "no code",
            operation: "commit",
          }),
        })
      )
    );
  });
});

const policy: RetryPolicy = {
  baseDelayMs: 10,
  maxAttempts: 4,
  maxDelayMs: 25,
  retryDeadlocks: true,
};

/** Runs `failing` with the schedule on the test clock; when each run started, and the error the retry ended with. */
const attemptsOf = (code: string, run: RetryPolicy) =>
  Effect.gen(function* () {
    const startedAt: number[] = [];

    const failing = Effect.gen(function* () {
      startedAt.push(yield* Clock.currentTimeMillis);

      return yield* sqlError(code);
    });

    const fiber = yield* Effect.forkChild(
      Effect.flip(Effect.retry(failing, transactionRetrySchedule(run)))
    );

    yield* TestClock.adjust("10 seconds");

    return { error: yield* Fiber.join(fiber), startedAt };
  });

describe("transactionRetrySchedule", () => {
  it.effect(
    "a serialization failure runs the effect maxAttempts times, waits within the core's backoff, and ends with the last error",
    () =>
      Effect.gen(function* () {
        const { error, startedAt } = yield* attemptsOf("40001", policy);

        assert.strictEqual(startedAt.length, policy.maxAttempts);
        assert.strictEqual(error._tag, "SqlError");

        // The wait before run k+1 is a draw in [0, backoffMs(policy, k, almost 1)]: the core's full-jitter bound.
        const gaps = Arr.map(
          Arr.drop(startedAt, 1),
          (at, index) => at - (startedAt[index] ?? 0)
        );

        assert.isTrue(
          Arr.every(
            gaps,
            (gap, index) => gap <= backoffMs(policy, index + 1, 0.999999)
          )
        );
      })
  );

  it.effect("a deadlock is retried only while the policy allows it", () =>
    Effect.gen(function* () {
      const allowed = yield* attemptsOf("40P01", policy);

      const refused = yield* attemptsOf("40P01", {
        ...policy,
        retryDeadlocks: false,
      });

      assert.strictEqual(allowed.startedAt.length, policy.maxAttempts);
      assert.strictEqual(refused.startedAt.length, 1);
    })
  );

  it.effect(
    "control: what the core does not retry runs once, and the error is the one that was raised",
    () =>
      Effect.gen(function* () {
        const unique = yield* attemptsOf("23505", defaultRetryPolicy);
        const aborted = yield* attemptsOf("25P02", defaultRetryPolicy);
        const unknown = yield* attemptsOf("XX000", defaultRetryPolicy);

        assert.deepStrictEqual(
          Arr.map([unique, aborted, unknown], (run) => run.startedAt.length),
          [1, 1, 1]
        );
      })
  );

  it.effect("a failure that is not an SqlError is never retried", () =>
    Effect.gen(function* () {
      let runs = 0;

      const error = yield* Effect.flip(
        Effect.retry(
          Effect.suspend(() => {
            runs += 1;

            return Effect.fail("not sql" as const);
          }),
          transactionRetrySchedule(policy)
        )
      );

      assert.strictEqual(runs, 1);
      assert.strictEqual(error, "not sql");
    })
  );
});
