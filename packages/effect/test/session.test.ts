import { assert, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Redacted, Schedule } from "effect";
import { SqlClient } from "effect/sql";

import { AdvisoryLockLostError, directLayer, TxSession } from "../src/index.ts";
import { fixture, Observer, Servers } from "./stack.ts";

/**
 * What a connection that keeps its session can do, on PostgreSQL directly: `LISTEN`, and a session advisory lock that
 * excludes another session. A transaction-pooled layer provides no `TxSession` (layers.test.ts); here the one that does.
 */

const direct = Layer.unwrap(
  Effect.map(Servers, (servers) =>
    directLayer({
      maxConnections: 3,
      url: Redacted.make(servers.postgres.endpoint.url),
    })
  )
);

const tryLock = (key: number) =>
  Effect.gen(function* () {
    const observer = yield* Observer;

    const rows =
      yield* observer`select pg_try_advisory_lock(${key}::bigint) as got`;

    const got = rows[0]?.got === true;

    if (got) {
      yield* observer`select pg_advisory_unlock(${key}::bigint)`;
    }

    return got;
  });

const holder = (key: number) =>
  Effect.gen(function* () {
    const observer = yield* Observer;

    const rows = yield* observer`select pid from pg_locks
      where locktype = 'advisory' and objid = ${key} and granted`;

    return rows.length === 0 ? undefined : Number(rows[0]?.pid);
  });

const untilHeld = (key: number) =>
  Effect.repeat(holder(key), {
    schedule: Schedule.spaced("20 millis"),
    until: (pid) => pid !== undefined,
  });

layer(fixture, { excludeTestServices: true, timeout: "90 seconds" })(
  "session",
  (suite) => {
    suite.layer(direct, { buildPerTest: true })((it) => {
      it.effect(
        "a notification sent on another session arrives on the queue",
        () =>
          Effect.gen(function* () {
            const session = yield* TxSession;
            const sql = yield* SqlClient.SqlClient;

            const queue = yield* session.listen("txmode_session_test");

            yield* sql`select pg_notify('txmode_session_test', 'hello')`;

            const notification = yield* Queue.take(queue);

            assert.strictEqual(notification.channel, "txmode_session_test");
            assert.strictEqual(notification.payload, "hello");
          }).pipe(Effect.scoped)
      );

      it.effect(
        "a session advisory lock excludes another session while the body runs, and not after",
        () =>
          Effect.gen(function* () {
            const session = yield* TxSession;

            // The control: nobody holds the lock, so the observer can take it.
            assert.isTrue(yield* tryLock(7));

            const during = yield* session.withAdvisoryLock(7, tryLock(7));

            assert.isFalse(during);
            assert.isTrue(yield* tryLock(7));
          })
      );

      it.effect("interrupting the body releases the lock", () =>
        Effect.gen(function* () {
          const session = yield* TxSession;

          const fiber = yield* Effect.forkChild(
            session.withAdvisoryLock(8, Effect.never)
          );

          yield* untilHeld(8);
          assert.isFalse(yield* tryLock(8));

          yield* Fiber.interrupt(fiber);

          assert.isTrue(yield* tryLock(8));
        })
      );

      it.effect(
        "a lock whose connection the server ends interrupts the body and fails with AdvisoryLockLostError",
        () =>
          Effect.gen(function* () {
            const session = yield* TxSession;
            const observer = yield* Observer;

            const fiber = yield* Effect.forkChild(
              Effect.flip(session.withAdvisoryLock(9, Effect.never))
            );

            const pid = yield* untilHeld(9);

            // The control: the body is still running while the connection is alive.
            yield* Effect.yieldNow;
            assert.isUndefined(fiber.pollUnsafe());

            yield* observer`select pg_terminate_backend(${pid})`;

            const error = yield* Fiber.join(fiber);

            assert.instanceOf(error, AdvisoryLockLostError);
            assert.strictEqual(error.key, 9);
          })
      );
    });
  }
);
