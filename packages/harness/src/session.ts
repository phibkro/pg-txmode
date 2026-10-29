import { createConnection } from "node:net";

import { Client } from "pg";

import type { Endpoint } from "./stack.ts";

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

/** The key a CancelRequest names: the process id and secret the server (or the pooler) sent at startup. */
export interface CancelKey {
  readonly processId: number;
  readonly secretKey: number;
}

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

const cancelRequestCode = 80_877_102;

/**
 * Sends a CancelRequest to `endpoint` on a new connection and waits for the server to close it:
 * https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS. The request names the key
 * the client received from the same endpoint, so a pooler recognises it.
 */
export const sendCancel = async (
  endpoint: Endpoint,
  key: CancelKey
): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<null>();
  const socket = createConnection({ host: endpoint.host, port: endpoint.port });
  const packet = Buffer.alloc(16);

  packet.writeInt32BE(16, 0);
  packet.writeInt32BE(cancelRequestCode, 4);
  packet.writeInt32BE(key.processId, 8);
  packet.writeInt32BE(key.secretKey, 12);
  socket.once("connect", () => {
    socket.write(packet);
  });
  socket.once("error", reject);
  socket.once("close", () => {
    resolve(null);
  });
  await promise;
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
