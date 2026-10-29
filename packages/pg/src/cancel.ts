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

/**
 * Stops what the client is running, then closes its socket. Closing alone is not enough: a backend that is executing a
 * statement (a long `pg_sleep`, a slow query) does not notice that its client is gone until the statement ends, and keeps
 * its locks meanwhile. The cancel ends the statement; the closed socket then ends the transaction, which PostgreSQL rolls back.
 */
export const cancelAndClose = async (client: PoolClient): Promise<void> => {
  try {
    await sendCancelRequest(client, cancelKey(client));
  } catch {
    // The cancel could not be sent (the connection is already gone); closing the socket is all that is left to do.
  } finally {
    client.connection.stream.destroy();
  }
};
