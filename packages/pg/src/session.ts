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
  /** `LISTEN channel` on a connection of its own. Returns the function that stops listening and closes it. */
  readonly listen: (
    channel: string,
    onNotify: (payload: string) => void
  ) => Promise<() => Promise<void>>;
  /** Holds the session-level advisory lock `key` on a connection of its own while `body` runs. */
  readonly withAdvisoryLock: <T>(
    key: number,
    body: () => Promise<T>
  ) => Promise<T>;
}

export const sessionMethods = (
  mode: ConnectionMode,
  config: ClientConfig
): SessionMethods => ({
  listen: async (channel, onNotify) => {
    requireFeature(mode, "listen");

    const client = new Client(config);

    await client.connect();
    client.on("notification", (message) => {
      if (message.channel === channel) {
        onNotify(message.payload ?? "");
      }
    });
    await client.query(`LISTEN ${escapeIdentifier(channel)}`);

    return async () => {
      await client.end();
    };
  },
  withAdvisoryLock: async (key, body) => {
    requireFeature(mode, "sessionAdvisoryLock");

    const client = new Client(config);

    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [key]);

    try {
      return await body();
    } finally {
      await client.end();
    }
  },
});
