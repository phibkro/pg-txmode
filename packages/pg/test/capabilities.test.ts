import {
  direct,
  hyperdrive,
  pgBouncer,
  sessionPooled,
  supavisor,
  UnsupportedFeatureError,
} from "@pg-txmode/core";
import { startStack } from "@pg-txmode/harness";
import type { Stack } from "@pg-txmode/harness";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vite-plus/test";

import { createDatabase, NamedStatementRefusedError } from "../src/index.ts";
import type { Database, TxClient } from "../src/index.ts";

/**
 * The adapter applies the capability record of the mode it is given. The mode is what the caller declares (the adapter
 * cannot detect a Hyperdrive); the tests point every pooled mode at the harness's PgBouncer, which stands in for it.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack(2);
}, 60_000);

afterAll(async () => {
  await stack.stop();
});

const pooledUrl = (): string => stack.pooler.endpoint.url;

describe("named prepared statements follow the mode", () => {
  test.each([
    ["PgBouncer with max_prepared_statements 0", pgBouncer(0)],
    ["Supavisor", supavisor],
  ])("%s: refused, quoting the catalogue row", async (_name, mode) => {
    const db = createDatabase({ connectionString: pooledUrl(), mode });

    await expect(
      db.query("SELECT 1 AS v", [], { name: "one" })
    ).rejects.toThrow(NamedStatementRefusedError);
    await expect(
      db.query("SELECT 1 AS v", [], { name: "one" })
    ).rejects.toThrow(/named-statements-untracked/u);
    await db.end();
  });

  test.each([
    ["PgBouncer with max_prepared_statements 1000", pgBouncer(1000)],
    ["Hyperdrive", hyperdrive],
  ])("%s: allowed, and the statement runs", async (_name, mode) => {
    const db = createDatabase({ connectionString: pooledUrl(), mode });

    expect(
      (await db.query("SELECT $1::int + 1 AS v", [41], { name: "plus-one" }))[0]
        ?.v
    ).toBe(42);
    await db.end();
  });

  test("an unnamed statement runs on every mode", async () => {
    for (const mode of [pgBouncer(0), supavisor]) {
      const db = createDatabase({ connectionString: pooledUrl(), mode });

      expect((await db.query("SELECT $1::int AS v", [7]))[0]?.v).toBe(7);
      await db.end();
    }
  });
});

describe("pipelining follows the mode", () => {
  test("is refused where the catalogue says no, and where it says nothing unless the caller accepts it", () => {
    expect(() =>
      createDatabase({
        connectionString: pooledUrl(),
        mode: supavisor,
        pipeline: true,
      })
    ).toThrow(UnsupportedFeatureError);
    expect(() =>
      createDatabase({
        connectionString: pooledUrl(),
        mode: hyperdrive,
        pipeline: true,
      })
    ).toThrow(/unverified/u);
  });

  test("is allowed where it was measured, and for an unverified mode that the caller accepts", async () => {
    for (const options of [
      { mode: pgBouncer(1000) },
      { allowUnverified: true, mode: hyperdrive },
    ]) {
      const db = createDatabase({
        connectionString: pooledUrl(),
        pipeline: true,
        ...options,
      });

      expect(db.capabilities.pipelining).not.toBe("no");
      await db.end();
    }
  });
});

describe("session-only API exists only where the session is kept", () => {
  test("a transaction-pooled database has no listen and no advisory lock, at run time", async () => {
    for (const mode of [hyperdrive, pgBouncer(1000), supavisor]) {
      const db = createDatabase({ connectionString: pooledUrl(), mode });

      expect("listen" in db).toBe(false);
      expect("withAdvisoryLock" in db).toBe(false);
      await db.end();
    }
  });

  test("a direct or session-pooled database has both", async () => {
    for (const mode of [direct, sessionPooled]) {
      const db = createDatabase({
        connectionString: stack.postgres.endpoint.url,
        mode,
      });

      expect("listen" in db).toBe(true);
      expect("withAdvisoryLock" in db).toBe(true);
      await db.end();
    }
  });

  test("and at compile time: the type has no such method for a pooled mode (negative control: it has for a direct one)", () => {
    expectTypeOf<Database<typeof hyperdrive>>().toEqualTypeOf<TxClient>();
    expectTypeOf<Database<typeof hyperdrive>>().not.toHaveProperty("listen");
    expectTypeOf<Database<typeof direct>>().toHaveProperty("listen");
    expectTypeOf<Database<typeof sessionPooled>>().toHaveProperty(
      "withAdvisoryLock"
    );
  });

  test("listen delivers a notification on a direct connection", async () => {
    const db = createDatabase({
      connectionString: stack.postgres.endpoint.url,
      mode: direct,
    });

    const { promise, resolve } = Promise.withResolvers<string>();
    const stop = await db.listen("txmode_demo", resolve);

    await db.query("SELECT pg_notify('txmode_demo', 'hello')");
    expect(await promise).toBe("hello");
    await stop();
    await db.end();
  });

  test("a session advisory lock excludes another session on a direct connection", async () => {
    const db = createDatabase({
      connectionString: stack.postgres.endpoint.url,
      mode: direct,
    });

    const tryLock = async (): Promise<boolean> =>
      Boolean((await db.query("SELECT pg_try_advisory_lock(42) AS v"))[0]?.v);

    const seenInside = await db.withAdvisoryLock(42, tryLock);
    const after = await tryLock();

    // The pool's connection is a session of its own, so inside the lock another session was refused; afterwards it is free.
    expect([seenInside, after]).toStrictEqual([false, true]);
    await db.end();
  });
});

describe("the database reports its capabilities", () => {
  test("they are the catalogue's, not the adapter's", () => {
    const db = createDatabase({
      connectionString: pooledUrl(),
      mode: hyperdrive,
    });

    expect(db.capabilities.sessionAdvisoryLock).toBe("no");
    expect(db.capabilities.cachesReads).toBe(true);
    expect(db.capabilities.preparedStatements).toBe("named-protocol");
  });
});
