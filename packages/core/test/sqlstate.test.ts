import { describe, expect, test } from "vite-plus/test";

import { classifyFailure, failureOf } from "../src/index.ts";

describe("classifyFailure", () => {
  test("40001 is retried as a whole transaction, 40P01 too", () => {
    expect(classifyFailure({ sqlState: "40001" })).toStrictEqual({
      kind: "serialization-failure",
      retry: "whole-transaction",
      sqlState: "40001",
    });
    expect(classifyFailure({ sqlState: "40P01" }).retry).toBe(
      "whole-transaction"
    );
  });

  test("a unique or exclusion violation is retried only where the domain says so", () => {
    expect(classifyFailure({ sqlState: "23505" }).retry).toBe("domain");
    expect(classifyFailure({ sqlState: "23P01" }).retry).toBe("domain");
  });

  test("25P02 is a symptom and is never retried", () => {
    expect(classifyFailure({ sqlState: "25P02" })).toStrictEqual({
      kind: "in-failed-transaction",
      retry: "never",
      sqlState: "25P02",
    });
  });

  test("timeouts and lost connections are never retried", () => {
    for (const [sqlState, kind] of [
      ["55P03", "lock-timeout"],
      ["25P03", "idle-in-transaction-timeout"],
      ["25P04", "transaction-timeout"],
      ["57P01", "connection-lost"],
      ["08006", "connection-lost"],
      ["58000", "pooler-error"],
    ] as const) {
      expect(classifyFailure({ sqlState })).toMatchObject({
        kind,
        retry: "never",
      });
    }
  });

  test("an SQLSTATE the policy does not know is 'other' and never retried", () => {
    expect(classifyFailure({ sqlState: "XX000" })).toMatchObject({
      kind: "other",
      retry: "never",
    });
  });
});

describe("57014 (a statement timeout and a cancel share the code)", () => {
  test("is told apart by the server's message", () => {
    expect(
      classifyFailure({
        message: "canceling statement due to statement timeout",
        sqlState: "57014",
      }).kind
    ).toBe("statement-timeout");
    expect(
      classifyFailure({
        message: "canceling statement due to user request",
        sqlState: "57014",
      }).kind
    ).toBe("user-cancel");
  });

  test("the message wins over a hint from the client", () => {
    expect(
      classifyFailure({
        cancelRequested: true,
        message: "canceling statement due to statement timeout",
        sqlState: "57014",
      }).kind
    ).toBe("statement-timeout");
  });

  test("without a message, the client's knowledge decides", () => {
    expect(
      classifyFailure({ cancelRequested: true, sqlState: "57014" }).kind
    ).toBe("user-cancel");
    expect(
      classifyFailure({
        cancelRequested: false,
        sqlState: "57014",
        statementTimeoutSet: true,
      }).kind
    ).toBe("statement-timeout");
  });

  test("without a message and without a hint it stays ambiguous, and is not retried", () => {
    expect(classifyFailure({ sqlState: "57014" })).toStrictEqual({
      kind: "cancel-or-timeout",
      retry: "never",
      sqlState: "57014",
    });
    expect(
      classifyFailure({ cancelRequested: false, sqlState: "57014" }).kind
    ).toBe("cancel-or-timeout");
  });
});

describe("failureOf", () => {
  test("reads the SQLSTATE of a driver error from `code`", () => {
    expect(
      failureOf({ code: "40001", message: "could not serialize access" })?.kind
    ).toBe("serialization-failure");
  });

  test("returns nothing for an error without an SQLSTATE", () => {
    expect(failureOf({ message: "socket hang up" })).toBeUndefined();
  });
});
