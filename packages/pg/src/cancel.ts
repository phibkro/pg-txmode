import { setTimeout as sleep } from "node:timers/promises";

import { sendCancelRequest } from "@pg-txmode/core/cancel";
import type { CancelKey } from "@pg-txmode/core/cancel";
import type { PoolClient } from "pg";

declare module "pg" {
  /**
   * node-postgres keeps the BackendKeyData of the startup in these two fields (lib/client.js: `processID`, `secretKey`);
   * its type declarations do not list them, and a CancelRequest needs both.
   */
  interface ClientBase {
    readonly processID: number;
    readonly secretKey: number;
  }
}

const cancelKey = (client: PoolClient): CancelKey => ({
  processId: client.processID,
  secretKey: client.secretKey,
});

/** How long each step of an abort (the cancel, then the `ROLLBACK`) may take before the socket is closed anyway. */
const graceMs = 2000;

const ignored = (): undefined => undefined;

/** Waits for `work` to end or `ms` to pass, whichever is first; a failure of `work` is not the caller's business here. */
const settleWithin = async (
  work: Promise<unknown>,
  ms: number
): Promise<void> => {
  const timer = new AbortController();

  await Promise.race([
    work.then(ignored, ignored),
    sleep(ms, undefined, { signal: timer.signal }).catch(ignored),
  ]);
  timer.abort();
};

/**
 * Ends the transaction of `client` as well as a client that is going away can, then closes its socket:
 *
 * 1. a CancelRequest, because a backend that is executing a statement (a long `pg_sleep`, a slow query) does not notice
 *    that its client is gone until the statement ends, and keeps its locks meanwhile;
 * 2. an explicit `ROLLBACK`, queued behind the cancelled statement: it is the behaviour that was measured through
 *    Hyperdrive (catalogue row `request-abort`), and it does not depend on the pooler noticing a closed socket;
 * 3. the socket is destroyed, which rolls an idle transaction back on a direct connection and behind PgBouncer.
 *
 * Each of the first two steps is given `graceMs`; an unreachable pooler cannot hold the close back for longer.
 */
export const cancelAndClose = async (client: PoolClient): Promise<void> => {
  try {
    await settleWithin(sendCancelRequest(client, cancelKey(client)), graceMs);
    await settleWithin(client.query("ROLLBACK"), graceMs);
  } finally {
    client.connection.stream.destroy();
  }
};
