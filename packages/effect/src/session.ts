import type { PgClient, PgConnection } from "@effect/sql-pg";
import { Context, Effect } from "effect";
import type { Queue, Scope } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { AdvisoryLockLostError } from "./errors.ts";

/**
 * What only a connection that keeps its session can do. A layer for `direct` or `sessionPooled` provides this service; a
 * transaction-pooled layer does not, so a program that needs it has an unsatisfied requirement and does not compile
 * against any transaction-pooled layer (the core's `SessionApi`, as a requirement).
 *
 * Contract. `listen` holds a connection until the scope closes and returns the notification queue; a connection that
 * fails ends the queue with the driver's `SqlError`. `withAdvisoryLock(key, body)` takes `pg_advisory_lock(key)` on a
 * connection of its own, runs `body` on the client's pool, and releases the lock when `body` ends, fails or is
 * interrupted; when the lock's connection ends first, `body` is interrupted and the call fails with
 * `AdvisoryLockLostError`.
 */
export class TxSession extends Context.Service<
  TxSession,
  {
    readonly listen: (
      channel: string
    ) => Effect.Effect<
      Queue.Dequeue<PgConnection.Notification, SqlError>,
      SqlError,
      Scope.Scope
    >;
    readonly withAdvisoryLock: <A, E, R>(
      key: number,
      body: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SqlError | AdvisoryLockLostError, R>;
  }
>()("@pg-txmode/effect/TxSession") {}

const lockSql = "select pg_advisory_lock($1::bigint)";
const unlockSql = "select pg_advisory_unlock($1::bigint)";

/** Parks the lock's connection: it is answered only when the connection ends or the watch is interrupted. */
const parkSql = "select pg_sleep(86400)";

export const makeTxSession = (
  client: PgClient.PgClient
): TxSession["Service"] =>
  TxSession.of({
    listen: client.listen,
    withAdvisoryLock: <A, E, R>(key: number, body: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const holder = yield* client.reserve;

          yield* holder.executeRaw(lockSql, [key]);
          yield* Effect.addFinalizer(() =>
            Effect.ignore(holder.executeRaw(unlockSql, [key]))
          );

          return yield* Effect.raceFirst(
            body,
            holder.executeRaw(parkSql, []).pipe(
              Effect.mapError(
                (cause) => new AdvisoryLockLostError({ cause, key })
              ),
              Effect.andThen(Effect.never)
            )
          );
        })
      ),
  });
