import { createConnection } from "node:net";

const cancelRequestCode = 80_877_102;

/** The BackendKeyData a server sends at startup: what a CancelRequest must name. */
export interface CancelKey {
  readonly processId: number;
  readonly secretKey: number;
}

/**
 * Sends a CancelRequest to `endpoint` on a new connection and waits for the server to close it:
 * https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS. The request names the key
 * the client received from the same endpoint, so a pooler recognises it (PgBouncer forwards it: catalogue row
 * `cancel-request`). Node's `net` is used, so this module is a separate entry of the package: `@pg-txmode/core/cancel`.
 */
export const sendCancelRequest = async (
  endpoint: { readonly host: string; readonly port: number },
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
