/**
 * What a failed statement means for the transaction around it, from the SQLSTATE and the message the server sent.
 *
 * Sources: the retry rule is https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html
 * ("retry the complete transaction"); the codes are https://www.postgresql.org/docs/current/errcodes-appendix.html; the
 * 57014 ambiguity (a statement timeout and a cancel share one code) is the harness probe `statement-timeout-vs-cancel`,
 * which observed both messages on PostgreSQL 18.
 */

export type FailureKind =
  | "serialization-failure"
  | "deadlock-detected"
  | "statement-timeout"
  | "user-cancel"
  /** 57014 with no message to tell the two apart and no word from the client whether it cancelled. */
  | "cancel-or-timeout"
  | "lock-timeout"
  | "idle-in-transaction-timeout"
  | "transaction-timeout"
  | "unique-violation"
  | "exclusion-violation"
  /** 25P02: a statement ran after an earlier one failed. A symptom; the cause is the earlier failure. */
  | "in-failed-transaction"
  | "connection-lost"
  /** 58000: Hyperdrive's code for an error that has no PostgreSQL equivalent. */
  | "pooler-error"
  | "other";

/** What a caller may do with a failed transaction. */
export type RetryClass =
  /** Run the whole transaction again, bounded. */
  | "whole-transaction"
  /** Retry only where the domain says the conflict is expected (an upsert race), never by default. */
  | "domain"
  | "never";

export interface Failure {
  readonly kind: FailureKind;
  readonly retry: RetryClass;
  readonly sqlState: string;
}

/** The part of a driver error the policy reads. `pg` and postgres.js both put the SQLSTATE in `code`. */
export interface SqlError {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

export interface ClassifyInput {
  readonly sqlState: string;
  readonly message?: string | undefined;
  /**
   * Whether this client sent a CancelRequest for the statement. `true` makes a 57014 without a recognisable message a
   * user cancel; `false` makes it a statement timeout only when a statement timeout was set. When the client says
   * nothing, such a 57014 stays `cancel-or-timeout`.
   */
  readonly cancelRequested?: boolean | undefined;
  readonly statementTimeoutSet?: boolean | undefined;
}

/** The kind of every SQLSTATE the policy knows; 57014 is told apart by `classifyCancel`. */
const kindOfCode = (sqlState: string): FailureKind => {
  switch (sqlState) {
    case "23505": {
      return "unique-violation";
    }

    case "23P01": {
      return "exclusion-violation";
    }

    case "25P02": {
      return "in-failed-transaction";
    }

    case "25P03": {
      return "idle-in-transaction-timeout";
    }

    case "25P04": {
      return "transaction-timeout";
    }

    case "40001": {
      return "serialization-failure";
    }

    case "40P01": {
      return "deadlock-detected";
    }

    case "55P03": {
      return "lock-timeout";
    }

    case "57P01":
    case "57P02":
    case "57P03": {
      return "connection-lost";
    }

    case "58000": {
      return "pooler-error";
    }

    default: {
      return sqlState.startsWith("08") ? "connection-lost" : "other";
    }
  }
};

const retryOf: Readonly<Record<FailureKind, RetryClass>> = {
  "cancel-or-timeout": "never",
  "connection-lost": "never",
  "deadlock-detected": "whole-transaction",
  "exclusion-violation": "domain",
  "idle-in-transaction-timeout": "never",
  "in-failed-transaction": "never",
  "lock-timeout": "never",
  other: "never",
  "pooler-error": "never",
  "serialization-failure": "whole-transaction",
  "statement-timeout": "never",
  "transaction-timeout": "never",
  "unique-violation": "domain",
  "user-cancel": "never",
};

/** 57014 query_canceled, told apart by the server's English message or by what the client knows. */
const classifyCancel = (input: ClassifyInput): FailureKind => {
  const message = input.message ?? "";

  if (message.includes("statement timeout")) {
    return "statement-timeout";
  }

  if (message.includes("user request")) {
    return "user-cancel";
  }

  if (input.cancelRequested === true) {
    return "user-cancel";
  }

  return input.cancelRequested === false && input.statementTimeoutSet === true
    ? "statement-timeout"
    : "cancel-or-timeout";
};

export const classifyFailure = (input: ClassifyInput): Failure => {
  const kind =
    input.sqlState === "57014"
      ? classifyCancel(input)
      : kindOfCode(input.sqlState);

  return { kind, retry: retryOf[kind], sqlState: input.sqlState };
};

/** The failure a driver error describes, or undefined when it carries no SQLSTATE (a bug, a timeout of the client). */
export const failureOf = (
  error: SqlError,
  context: Pick<ClassifyInput, "cancelRequested" | "statementTimeoutSet"> = {}
): Failure | undefined =>
  error.code === undefined
    ? undefined
    : classifyFailure({
        ...context,
        message: error.message,
        sqlState: error.code,
      });
