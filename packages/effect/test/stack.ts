import { PgClient } from "@effect/sql-pg";
import { neonProfile, startPgBouncer, startPostgres } from "@pg-txmode/harness";
import type { Pooler, Postgres } from "@pg-txmode/harness";
import { Context, Effect, Layer, Redacted, Schedule } from "effect";
import { Reactivity } from "effect/reactivity";

/**
 * A throwaway PostgreSQL with two PgBouncers in front of it (Neon's profile, the harness's servers), built once per
 * `layer(...)` block and stopped when the block ends.
 */
export class Servers extends Context.Service<
  Servers,
  {
    readonly postgres: Postgres;
    /** Transaction mode, `max_prepared_statements = 1000`, two server connections. */
    readonly tracked: Pooler;
    /** Transaction mode, `max_prepared_statements = 0`, three server connections. */
    readonly untracked: Pooler;
  }
>()("test/Servers") {
  static readonly layer = Layer.effect(
    Servers,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const postgres = yield* Effect.promise(() => startPostgres());
        const profile = neonProfile(postgres.maxConnections);

        const tracked = yield* Effect.promise(() =>
          startPgBouncer(postgres, {
            ...profile,
            defaultPoolSize: 2,
            maxPreparedStatements: 1000,
          })
        );

        const untracked = yield* Effect.promise(() =>
          startPgBouncer(postgres, {
            ...profile,
            defaultPoolSize: 3,
            maxPreparedStatements: 0,
          })
        );

        return Servers.of({ postgres, tracked, untracked });
      }),
      (servers) =>
        Effect.promise(() => servers.tracked.stop()).pipe(
          Effect.andThen(Effect.promise(() => servers.untracked.stop())),
          Effect.andThen(Effect.promise(() => servers.postgres.stop()))
        )
    )
  );
}

/**
 * A client of its own on PostgreSQL itself, never through a pooler: what the server says about the sessions of the
 * subject under test. It is a plain `PgClient`, not one of this package's layers, so it cannot share a defect with them.
 */
export class Observer extends Context.Service<Observer, PgClient.PgClient>()(
  "test/Observer"
) {
  static readonly layer = Layer.effect(
    Observer,
    Effect.flatMap(Servers, (servers) =>
      PgClient.make({
        maxConnections: 2,
        prepare: false,
        url: Redacted.make(servers.postgres.endpoint.url),
      })
    )
  ).pipe(Layer.provide(Reactivity.layer));
}

/** The servers and the observer on them: the fixture of every test block. */
export const fixture = Observer.layer.pipe(Layer.provideMerge(Servers.layer));

/** Backends that are inside a transaction or running a statement, other than the observer's own. */
export const busyBackends = Effect.gen(function* () {
  const observer = yield* Observer;

  const rows = yield* observer`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
        and (state like 'idle in transaction%' or state = 'active')`;

  return Number(rows[0]?.n ?? 0);
});

/** Waits, by polling the server, until a statement that starts with `text` is running. */
export const untilRunning = (text: string) =>
  Effect.gen(function* () {
    const observer = yield* Observer;

    yield* Effect.repeat(
      Effect.map(
        observer`select count(*)::int as n from pg_stat_activity
          where state = 'active' and query like ${`${text}%`} and pid <> pg_backend_pid()`,
        (rows) => Number(rows[0]?.n ?? 0)
      ),
      { schedule: Schedule.spaced("20 millis"), until: (n) => n > 0 }
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.die(`no statement starting with ${text} became active`),
    })
  );
