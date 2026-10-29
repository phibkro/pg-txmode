import { requireFeature } from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";
import { Client, escapeIdentifier } from "pg";
import type { ClientConfig } from "pg";

/**
 * The API that needs a session of one's own: it exists on a `Direct` or `SessionPooled` database and on no other
 * (`SessionApi` of the core is `never` for a transaction-pooled mode, and the object has no such method then). Each call
 * opens a dedicated connection, because a session feature belongs to one connection that nobody else may take.
 */
export interface SessionMethods {
  /**
   * `LISTEN channel` on a connection of its own. Returns the function that stops listening and closes it. `onError` is
   * called once if the server or the network ends the session: from then on no notification arrives, and the caller must
   * listen again (required, so that the loss is never silent).
   */
  readonly listen: (
    channel: string,
    onNotify: (payload: string) => void,
    onError: (error: Error) => void
  ) => Promise<() => Promise<void>>;
  /**
   * Holds the session-level advisory lock `key` on a connection of its own while `body` runs. `lost` aborts, with the
   * error as its reason, if the session ends while `body` runs: the lock is then released and `body` no longer holds it.
   */
  readonly withAdvisoryLock: <T>(
    key: number,
    body: (lost: AbortSignal) => Promise<T>
  ) => Promise<T>;
}

/** A client that is connected and that reports the end of its session to `onError` instead of throwing it. */
const connectSession = async (
  config: ClientConfig,
  onError: (error: Error) => void
): Promise<Client> => {
  const client = new Client(config);
  const reported = { done: false };

  // Registered before `connect`: an 'error' event with no listener is an uncaught exception that ends the process.
  client.on("error", (error) => {
    if (!reported.done) {
      reported.done = true;
      onError(error);
    }
  });
  await client.connect();

  return client;
};

/** Ends `client` and says nothing about it: the setup failure that called this is what the caller must see. */
const endQuietly = async (client: Client): Promise<void> => {
  try {
    await client.end();
  } catch {
    // The session is already gone; the error that matters is the one that is being thrown.
  }
};

export const sessionMethods = (
  mode: ConnectionMode,
  config: ClientConfig
): SessionMethods => ({
  listen: async (channel, onNotify, onError) => {
    requireFeature(mode, "listen");

    const client = await connectSession(config, onError);

    try {
      client.on("notification", (message) => {
        if (message.channel === channel) {
          onNotify(message.payload ?? "");
        }
      });
      await client.query(`LISTEN ${escapeIdentifier(channel)}`);
    } catch (error) {
      await endQuietly(client);

      throw error;
    }

    return async () => {
      await client.end();
    };
  },
  withAdvisoryLock: async (key, body) => {
    requireFeature(mode, "sessionAdvisoryLock");

    const lost = new AbortController();

    const client = await connectSession(config, (error) => {
      lost.abort(error);
    });

    try {
      await client.query("SELECT pg_advisory_lock($1)", [key]);

      return await body(lost.signal);
    } finally {
      await endQuietly(client);
    }
  },
});
