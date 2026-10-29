import {
  beginStatement,
  capabilities,
  timeoutStatements,
} from "@pg-txmode/core";
import type {
  Capabilities,
  ConnectionMode,
  RetryPolicy,
  TransactionOptions as CoreTransactionOptions,
} from "@pg-txmode/core";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import {
  InvalidTransactionOptionsError,
  NestedTransactionError,
} from "./errors.ts";
import type { ModeRefusedError } from "./errors.ts";
import { requireModeFeature } from "./refusal.ts";
import { transactionRetrySchedule } from "./retry.ts";

/** What a transaction asks for: the core's isolation level, access mode and timeouts, and the retry policy. */
export interface TransactionOptions extends CoreTransactionOptions {
  /** Run the whole body again after 40001 or 40P01 (the core's policy); `false` runs it once. Defaults to `defaultRetryPolicy`. */
  readonly retry?: RetryPolicy | false;
}

/** Which run of the transaction body this is: 1 for the first, 2 for the first retry, and so on. */
export const TxAttempt = Context.Reference<number>(
  "@pg-txmode/effect/TxAttempt",
  { defaultValue: () => 1 }
);

/**
 * The transaction door of a client built for one connection mode.
 *
 * Contract. `transaction(body, options)` runs the whole of `body` in one transaction on one connection of the client's
 * pool: `BEGIN` with the options' isolation level and access mode (one statement), the timeouts as `SET LOCAL`, the body,
 * `COMMIT`. It does nothing until it is run. The body MUST be safe to run again, because 40001 and 40P01 run it again as a
 * whole and its side effects outside the database MUST wait until `transaction` has returned; `TxAttempt` tells it which
 * run it is. Errors: the body's own `E`, `SqlError` (the last failure after the retry budget, unchanged), and the
 * refusals named below; none of them is recovered here. Interruption cancels the running statement, rolls the transaction
 * back and returns the connection before the interrupt completes; a transaction whose `COMMIT` was sent is not undone by
 * interruption (the outcome is unknown). A transaction is not durable state: the retry is in process only.
 */
export class TxClient extends Context.Service<
  TxClient,
  {
    readonly mode: ConnectionMode;
    readonly capabilities: Capabilities;
    readonly transaction: <A, E, R>(
      body: Effect.Effect<A, E, R>,
      options?: TransactionOptions
    ) => Effect.Effect<
      A,
      | E
      | SqlError
      | ModeRefusedError
      | InvalidTransactionOptionsError
      | NestedTransactionError,
      R
    >;
  }
>()("@pg-txmode/effect/TxClient") {}

export interface TxClientOptions {
  /** Accept a behaviour that is neither documented nor measured for the mode (`unverified`). Off by default. */
  readonly allowUnverified?: boolean | undefined;
}

/** The refusal of a nested `transaction`; built when it is needed. */
const nestedError = () =>
  new NestedTransactionError({
    message:
      "transaction ran inside a transaction of the same client: a nested transaction is a savepoint and would drop the isolation level, timeouts and retry; use sql.withTransaction for a savepoint",
  });

/** The `TxClient` of `mode` over any `SqlClient` (a test double, or a client of another driver). */
export const makeTxClient = (
  mode: ConnectionMode,
  sql: SqlClient.SqlClient,
  options: TxClientOptions = {}
): TxClient["Service"] => {
  const allowUnverified = options.allowUnverified === true;

  const transaction = Effect.fn("TxClient.transaction")(function* <A, E, R>(
    body: Effect.Effect<A, E, R>,
    run: TransactionOptions = {}
  ): Effect.fn.Return<
    A,
    | E
    | SqlError
    | ModeRefusedError
    | InvalidTransactionOptionsError
    | NestedTransactionError,
    R
  > {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* nestedError();
    }

    if (run.isolation !== undefined) {
      yield* requireModeFeature(mode, "isolationLevel", allowUnverified);
    }

    const settings = yield* Effect.try({
      catch: (error) =>
        new InvalidTransactionOptionsError({
          message: error instanceof Error ? error.message : String(error),
        }),
      try: () => timeoutStatements(run.timeouts),
    });

    if (settings.length > 0) {
      yield* requireModeFeature(
        mode,
        "transactionLocalSettings",
        allowUnverified
      );
    }

    const begin =
      run.isolation === undefined && run.readOnly === undefined
        ? undefined
        : beginStatement(run);

    let attempts = 0;

    const once = Effect.suspend(() => {
      attempts += 1;

      return sql
        .withTransaction(
          Effect.andThen(
            Effect.forEach(settings, (text) => sql.unsafe(text).unprepared, {
              discard: true,
            }),
            body
          )
        )
        .pipe(
          Effect.provideService(SqlClient.BeginTransaction, begin),
          Effect.provideService(TxAttempt, attempts)
        );
    });

    return run.retry === false
      ? yield* once
      : yield* Effect.retry(once, transactionRetrySchedule(run.retry));
  });

  return TxClient.of({
    capabilities: capabilities(mode),
    mode,
    transaction,
  });
};

/** The `TxClient` of `mode`, built from the `SqlClient` in the context; a test layer needs no driver. */
export const txClientLayer = (
  mode: ConnectionMode,
  options: TxClientOptions = {}
): Layer.Layer<TxClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    TxClient,
    Effect.map(SqlClient.SqlClient, (sql) => makeTxClient(mode, sql, options))
  );
