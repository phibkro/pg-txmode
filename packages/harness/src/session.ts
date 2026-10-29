import type { CancelKey } from "@pg-txmode/core/cancel";
import { Client } from "pg";

declare module "pg" {
  /**
   * node-postgres keeps the BackendKeyData of the startup in these two fields (lib/client.js: `processID`, `secretKey`);
   * its type declarations do not list them, and a CancelRequest needs both.
   */
  interface Client {
    readonly processID: number;
    readonly secretKey: number;
  }
}

/** A value a probe sends or reads. Probes cast to `text`, `int` or `boolean` so a driver returns one of these. */
export type Value = string | number | boolean | null;

export type Row = Readonly<Record<string, Value>>;

/**
 * One client connection, whatever the driver. The probes of this harness talk to it, so any client can be put through
 * them: write a `Connect` for the client and hand it to `runProbe`.
 */
export interface Session {
  readonly cancelKey: CancelKey;
  readonly query: (
    text: string,
    values?: readonly Value[]
  ) => Promise<readonly Row[]>;
  /** A protocol-level named prepared statement: the driver sends Parse once per connection and Bind afterwards. */
  readonly queryNamed: (
    name: string,
    text: string,
    values: readonly Value[]
  ) => Promise<readonly Row[]>;
  /** Closes the socket without a Terminate message, as a crashed or aborted client does. */
  readonly destroy: () => void;
  readonly end: () => Promise<void>;
}

export type Connect = () => Promise<Session>;

export interface ConnectOptions {
  /** The driver's own pipelining switch: queries are written without waiting for the previous answer. */
  readonly pipeline?: boolean;
}

export const pgConnect =
  (url: string, options: ConnectOptions = {}): Connect =>
  async () => {
    const client = new Client({
      connectionString: url,
      pipeline: options.pipeline,
    });

    // The server ends a session with a FATAL error (idle_in_transaction_session_timeout, transaction_timeout, an
    // administrator's termination). node-postgres reports it as an 'error' event, not on a query, and a later query
    // then fails with "Client has encountered a connection error and is not queryable" and no SQLSTATE. The event is the
    // only place the SQLSTATE appears, so the session keeps it and a failed query throws it instead.
    let fatalError: Error | undefined;

    client.on("error", (error: Error) => {
      // The server's FATAL message comes first; the "Connection terminated unexpectedly" of the closing socket follows.
      fatalError ??= error;
    });
    await client.connect();

    const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw fatalError ?? error;
      }
    };

    return {
      cancelKey: { processId: client.processID, secretKey: client.secretKey },
      destroy: () => {
        client.connection.stream.destroy();
      },
      end: async () => {
        await client.end();
      },
      query: async (text, values = []) =>
        (await guarded(async () => await client.query<Row>(text, [...values])))
          .rows,
      queryNamed: async (name, text, values) =>
        (
          await guarded(
            async () =>
              await client.query<Row>({ name, text, values: [...values] })
          )
        ).rows,
    };
  };

/** The error a promise rejects with, or undefined when it resolves. */
export const rejection = async <T>(
  promise: Promise<T>
): Promise<Error | undefined> => {
  try {
    await promise;

    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};
