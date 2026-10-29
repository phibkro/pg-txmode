import { describe, expect, test } from "vite-plus/test";

import {
  backoffMs,
  beginStatement,
  defaultRetryPolicy,
  InvalidTimeoutError,
  openingScript,
  openingStatements,
  retryDecision,
  timeoutStatements,
  withTransactionRetry,
} from "../src/index.ts";
import type { Failure, RetryPolicy } from "../src/index.ts";

const serialization: Failure = {
  kind: "serialization-failure",
  retry: "whole-transaction",
  sqlState: "40001",
};

const deadlock: Failure = {
  kind: "deadlock-detected",
  retry: "whole-transaction",
  sqlState: "40P01",
};

const unique: Failure = {
  kind: "unique-violation",
  retry: "domain",
  sqlState: "23505",
};

const sqlError = (code: string, message = "failed"): Error =>
  Object.assign(new Error(message), { code });

describe("opening a transaction", () => {
  test("BEGIN carries the isolation level and the access mode", () => {
    expect(beginStatement()).toBe("BEGIN");
    expect(beginStatement({ isolation: "serializable" })).toBe(
      "BEGIN ISOLATION LEVEL SERIALIZABLE"
    );
    expect(
      beginStatement({ isolation: "repeatable read", readOnly: true })
    ).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(beginStatement({ readOnly: false })).toBe("BEGIN READ WRITE");
  });

  test("timeouts become transaction-local settings with the number inlined", () => {
    expect(
      timeoutStatements({
        idleInTransactionMs: 5000,
        lockMs: 200,
        statementMs: 1000,
        transactionMs: 30_000,
      })
    ).toStrictEqual([
      "SET LOCAL idle_in_transaction_session_timeout = 5000",
      "SET LOCAL lock_timeout = 200",
      "SET LOCAL statement_timeout = 1000",
      "SET LOCAL transaction_timeout = 30000",
    ]);
    expect(timeoutStatements()).toStrictEqual([]);
  });

  test("a timeout that is not a non-negative integer is refused before any SQL exists", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => timeoutStatements({ statementMs: bad })).toThrow(
        InvalidTimeoutError
      );
    }
  });

  test("the opening is one script: BEGIN and every SET LOCAL, in order", () => {
    const options = {
      isolation: "serializable",
      timeouts: { lockMs: 100, statementMs: 2000 },
    } as const;

    expect(openingStatements(options)).toStrictEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SET LOCAL lock_timeout = 100",
      "SET LOCAL statement_timeout = 2000",
    ]);
    expect(openingScript(options)).toBe(
      "BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL lock_timeout = 100; SET LOCAL statement_timeout = 2000;"
    );
  });
});

describe("retryDecision", () => {
  const policy: RetryPolicy = {
    baseDelayMs: 10,
    maxAttempts: 3,
    maxDelayMs: 100,
    retryDeadlocks: true,
  };

  test("retries a whole-transaction failure until the attempts run out", () => {
    expect(retryDecision(serialization, 1, policy, 1).retry).toBe(true);
    expect(retryDecision(serialization, 2, policy, 1).retry).toBe(true);
    expect(retryDecision(serialization, 3, policy, 1).retry).toBe(false);
  });

  test("never retries a domain failure, and retries a deadlock only when the policy allows", () => {
    expect(retryDecision(unique, 1, policy, 0).retry).toBe(false);
    expect(retryDecision(deadlock, 1, policy, 0).retry).toBe(true);
    expect(
      retryDecision(deadlock, 1, { ...policy, retryDeadlocks: false }, 0).retry
    ).toBe(false);
  });

  test("backs off exponentially with full jitter, capped", () => {
    expect(backoffMs(policy, 1, 0.999)).toBe(9);
    expect(backoffMs(policy, 2, 0.999)).toBe(19);
    expect(backoffMs(policy, 5, 0.999)).toBe(99);
    expect(backoffMs(policy, 5, 0)).toBe(0);
  });
});

describe("withTransactionRetry", () => {
  const noSleep = { sleep: async () => {} };

  test("runs the whole attempt again after a serialization failure and returns the result", async () => {
    const attempts: number[] = [];

    const result = await withTransactionRetry(async (attempt) => {
      attempts.push(attempt);

      return attempt < 3
        ? await Promise.reject(sqlError("40001"))
        : await Promise.resolve("committed");
    }, noSleep);

    expect(result).toBe("committed");
    expect(attempts).toStrictEqual([1, 2, 3]);
  });

  test("waits the backoff between attempts and reports each retry", async () => {
    const waits: number[] = [];
    const retried: string[] = [];

    await withTransactionRetry(
      async (attempt) =>
        attempt < 3
          ? await Promise.reject(sqlError("40P01"))
          : await Promise.resolve(null),
      {
        onRetry: (failure, attempt) => {
          retried.push(`${failure.kind}@${attempt}`);
        },
        random: () => 0.5,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }
    );

    expect(waits).toStrictEqual([
      backoffMs(defaultRetryPolicy, 1, 0.5),
      backoffMs(defaultRetryPolicy, 2, 0.5),
    ]);
    expect(retried).toStrictEqual([
      "deadlock-detected@1",
      "deadlock-detected@2",
    ]);
  });

  test("stops at the cap and throws the last failure unchanged", async () => {
    const last = sqlError("40001", "could not serialize access");
    let runs = 0;

    await expect(
      withTransactionRetry(
        async () => {
          runs += 1;

          throw last;
        },
        { ...noSleep, policy: { ...defaultRetryPolicy, maxAttempts: 4 } }
      )
    ).rejects.toBe(last);
    expect(runs).toBe(4);
  });

  test.each([
    sqlError("23505"),
    sqlError("57014"),
    sqlError("25P02"),
    new Error("no SQLSTATE"),
  ])(
    "runs a failure that must not be retried exactly once: %s",
    async (error) => {
      let runs = 0;

      await expect(
        withTransactionRetry(async () => {
          runs += 1;

          throw error;
        }, noSleep)
      ).rejects.toBe(error);
      expect(runs).toBe(1);
    }
  );
});
