import { describe, expect, test } from "vite-plus/test";

import { cancelAndClose } from "../src/cancel.ts";
import type { Abortable } from "../src/cancel.ts";

/**
 * The end of an abort, in order: the CancelRequest, then `ROLLBACK`, then the socket. Against a real server the closed
 * socket ends the transaction by itself, so no server-side test can tell `ROLLBACK` from its absence; the order of calls
 * on the client is what the adapter promises (the evidence for Hyperdrive is an explicit rollback).
 */

/** A client that records what is done to it. Its port is closed, so the CancelRequest fails at once (ECONNREFUSED). */
const recorder = (rollback: () => Promise<object>) => {
  const calls: string[] = [];

  const client: Abortable = {
    connection: {
      stream: {
        destroy: () => {
          calls.push("destroy");
        },
      },
    },
    host: "127.0.0.1",
    port: 1,
    processID: 1,
    query: async (text) => {
      calls.push(text);

      return await rollback();
    },
    secretKey: 1,
  };

  return { calls, client };
};

describe("cancelAndClose", () => {
  test("sends ROLLBACK, then closes the socket", async () => {
    const { calls, client } = recorder(async () => await Promise.resolve({}));

    await cancelAndClose(client);
    expect(calls).toStrictEqual(["ROLLBACK", "destroy"]);
  });

  test("closes the socket even when ROLLBACK fails or never answers, after the grace period", async () => {
    const failing = recorder(
      async () => await Promise.reject(new Error("gone"))
    );

    await cancelAndClose(failing.client);
    expect(failing.calls).toStrictEqual(["ROLLBACK", "destroy"]);

    const silent = recorder(
      async () =>
        await new Promise<object>(() => {
          // never settles: the pooler swallowed the statement
        })
    );

    const started = Date.now();

    await cancelAndClose(silent.client, 100);
    expect(silent.calls).toStrictEqual(["ROLLBACK", "destroy"]);
    // The grace period is real time: 100 ms for the ROLLBACK step (the refused CancelRequest takes no time).
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});
