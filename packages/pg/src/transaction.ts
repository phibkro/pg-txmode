import { openingScript, withTransactionRetry } from "@pg-txmode/core";
import type { Failure, RetryPolicy, TransactionOptions } from "@pg-txmode/core";
import type { Pool, PoolClient } from "pg";

import { TransactionAbortedError } from "./abort.ts";
import { cancelAndClose } from "./cancel.ts";
import type { Executor, Param, Row, StatementOptions } from "./statement.ts";

export interface Transaction {
  /** 1 for the first run of the transaction body, 2 for the first retry, and so on. */
  readonly attempt: number;
  readonly query: (
    text: string,
    values?: readonly Param[],
    options?: StatementOptions
  ) => Promise<readonly Row[]>;
}

export interface TransactionRunOptions extends TransactionOptions {
  /**
   * The request's signal. When it aborts, the connection is closed and the transaction is rolled back by the server; the
   * call rejects with `TransactionAbortedError`. A transaction must not outlive its request: on Cloudflare Workers the
   * signal exists only with the `enable_request_signal` compatibility flag (catalogue row `request-abort`).
   */
  readonly signal?: AbortSignal;
  /** Run the whole body again after 40001 or 40P01; `false` runs it once. Defaults to `defaultRetryPolicy`. */
  readonly retry?: RetryPolicy | false;
  /** Called before each retry: the failure and the attempt that ended in it. */
  readonly onRetry?: (failure: Failure, attempt: number) => void;
  /** Waits between attempts; defaults to a timer. For tests. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * The server ends a session with a FATAL error (idle_in_transaction_session_timeout, transaction_timeout): node-postgres
 * reports it only as an 'error' event, and the next query fails with a message that has no SQLSTATE. The first event is the
 * server's own, so it is kept and thrown in place of the query's.
 */
const watch = (client: PoolClient) => {
  let first: Error | undefined;

  const listener = (error: Error): void => {
    first ??= error;
  };

  client.on("error", listener);

  return {
    fatal: (): Error | undefined => first,
    stop: (): void => {
      client.off("error", listener);
    },
  };
};

const rollBack = async (client: PoolClient): Promise<boolean> => {
  try {
    await client.query("ROLLBACK");

    return true;
  } catch {
    return false;
  }
};

interface Attempt<T> {
  readonly pool: Pool;
  readonly execute: Executor;
  readonly body: (tx: Transaction) => Promise<T>;
  readonly options: TransactionRunOptions;
  readonly number: number;
}

/** One run of the whole transaction on one connection; the connection is released, or destroyed when it cannot be trusted. */
const runOnce = async <T>({
  pool,
  execute,
  body,
  options,
  number,
}: Attempt<T>): Promise<T> => {
  const { signal } = options;
  const isAborted = (): boolean => signal?.aborted === true;

  if (isAborted()) {
    throw new TransactionAbortedError(false);
  }

  const client = await pool.connect();

  // The request may have gone away while this call queued for a connection: nothing has run on it, so give it back.
  if (isAborted()) {
    client.release();

    throw new TransactionAbortedError(false);
  }

  const watcher = watch(client);
  let commitSent = false;
  let healthy = false;
  let closing: Promise<void> | undefined;

  const onAbort = (): void => {
    if (!healthy) {
      closing = cancelAndClose(client);
    }
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await client.query(openingScript(options));

    const result = await body({
      attempt: number,
      query: async (text, values = [], statement = {}) =>
        await execute(client, text, values, statement),
    });

    commitSent = true;
    await client.query("COMMIT");
    healthy = true;

    return result;
  } catch (error) {
    if (isAborted()) {
      // The cancel and the close are under way; the connection is not used again.
      await closing;

      throw new TransactionAbortedError(commitSent);
    }

    healthy = await rollBack(client);

    throw watcher.fatal() ?? error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    watcher.stop();
    client.release(!healthy);
  }
};

/**
 * Runs `body` as one transaction on one connection of `pool`, opening it with the options' isolation level and timeouts in
 * one round trip, and runs the whole of it again after a serialization failure or a deadlock. `body` MUST be safe to run
 * more than once: no side effect outside the database until `runTransaction` has returned.
 */
export const runTransaction = async <T>(
  pool: Pool,
  execute: Executor,
  body: (tx: Transaction) => Promise<T>,
  options: TransactionRunOptions = {}
): Promise<T> => {
  const attempt = async (number: number): Promise<T> =>
    await runOnce({ body, execute, number, options, pool });

  if (options.retry === false) {
    return await attempt(1);
  }

  return await withTransactionRetry(attempt, {
    onRetry: options.onRetry,
    policy: options.retry,
    sleep: options.sleep,
  });
};
