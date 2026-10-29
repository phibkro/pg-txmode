import { setTimeout as sleep } from "node:timers/promises";

import { direct } from "@pg-txmode/core";
import { rejection, startPostgres } from "@pg-txmode/harness";
import type { Postgres } from "@pg-txmode/harness";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createDatabase } from "../src/index.ts";
import type { Database } from "../src/index.ts";

/**
 * A session of its own is a connection nobody watches: the server can end it, and the adapter must say so instead of
 * throwing an uncaught exception, and must not keep a connection that failed to set up.
 */

let postgres: Postgres;
let db: Database<typeof direct>;

const sessionUrl = (name: string): string =>
  `${postgres.endpoint.url}?application_name=${name}`;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDatabase({
    connectionString: postgres.endpoint.url,
    mode: direct,
  });
}, 60_000);

afterAll(async () => {
  await db.end();
  await postgres.stop();
});

const backendsNamed = async (name: string): Promise<number> =>
  Number(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [name]
      )
    )[0]?.n
  );

/** Polls the server until `done` holds: the server's own bookkeeping, not a guessed delay. */
const until = async (done: () => Promise<boolean>): Promise<boolean> => {
  for (let tries = 0; tries < 250; tries += 1) {
    if (await done()) {
      return true;
    }

    await sleep(20);
  }

  return false;
};

const terminate = async (name: string): Promise<void> => {
  await db.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
    [name]
  );
};

describe("a session of its own that the server ends", () => {
  test("listen reports the loss to onError, once, and the process does not die", async () => {
    const name = "txmode_listen_lost";

    const session = createDatabase({
      connectionString: sessionUrl(name),
      mode: direct,
    });

    const errors: Error[] = [];

    const stop = await session.listen(
      "lost",
      () => {},
      (error) => {
        errors.push(error);
      }
    );

    await terminate(name);
    expect(
      await until(async () => await Promise.resolve(errors.length > 0))
    ).toBe(true);
    // The client then reports a second error ("Connection terminated unexpectedly"); only the first is passed on.
    await sleep(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "57P01" });
    await stop().catch(() => {});
    await session.end();
  });

  test("withAdvisoryLock tells the body that the lock is lost", async () => {
    const name = "txmode_lock_lost";

    const session = createDatabase({
      connectionString: sessionUrl(name),
      mode: direct,
    });

    const reason = await session.withAdvisoryLock(7, async (lost) => {
      // The listener first: the signal can fire as soon as the backend is terminated.
      const gone = new Promise<null>((resolve) => {
        lost.addEventListener("abort", () => {
          resolve(null);
        });
      });

      await terminate(name);
      await gone;

      const why: unknown = lost.reason;

      return why;
    });

    expect(reason).toMatchObject({ code: "57P01" });
    await session.end();
  });
});

describe("a session that fails to set up is not kept", () => {
  test("a failing advisory lock ends its connection and throws the cause", async () => {
    const name = "txmode_lock_setup";

    const session = createDatabase({
      connectionString: sessionUrl(name),
      mode: direct,
    });

    // 1e30 is sent as the text "1e+30", which is not a bigint: the lock statement fails after the connection was made.
    const error = await rejection(
      session.withAdvisoryLock(1e30, async () => await Promise.resolve(null))
    );

    expect(error).toMatchObject({ code: "22P02" });
    expect(await until(async () => (await backendsNamed(name)) === 0)).toBe(
      true
    );
    await session.end();
  });

  test("a failing LISTEN ends its connection and throws the cause", async () => {
    const name = "txmode_listen_setup";

    const session = createDatabase({
      connectionString: sessionUrl(name),
      mode: direct,
    });

    // An empty channel name is a zero-length identifier: LISTEN fails after the connection was made.
    const error = await rejection(
      session.listen(
        "",
        () => {},
        () => {}
      )
    );

    expect(error).toMatchObject({ code: "42601" });
    expect(await until(async () => (await backendsNamed(name)) === 0)).toBe(
      true
    );
    await session.end();
  });
});
