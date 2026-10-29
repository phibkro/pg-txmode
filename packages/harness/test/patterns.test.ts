import {
  claimJob,
  conditionalUpdate,
  failureOf,
  openingScript,
  outbox,
  transactionContext,
} from "@pg-txmode/core";
import { describe, expect, test } from "vite-plus/test";

import type { Connect } from "../src/index.ts";
import { rejection } from "../src/index.ts";
import { withExampleSchema } from "../src/patternProbes.ts";
import { withSessions } from "../src/probe.ts";
import { one, seed, targetOf, useStack, withTwo } from "./fixtures.ts";

/**
 * The SQL constructs of `@pg-txmode/core`, run through PgBouncer in transaction mode with a pool of two server
 * connections, so concurrent clients really do share and swap server connections. The row-lock, `ON CONFLICT`,
 * savepoint, isolation and retry constructs are also probes (`packages/harness/src/patternProbes.ts`); the rest are here.
 */

const stack = useStack(2);

const withSchema = async <T>(use: () => Promise<T>): Promise<T> =>
  await withExampleSchema(targetOf(stack()), use);

/** Every id a worker takes until the statement returns no row. */
const drain = async (
  connect: Connect,
  statement: string,
  values: readonly (string | number)[],
  column: string
): Promise<readonly number[]> =>
  await withSessions(connect, 1, async ([session]) => {
    const take = async (): Promise<readonly number[]> => {
      const rows = (await session?.query(statement, values)) ?? [];

      return rows.length === 0
        ? []
        : [...rows.map((row) => Number(row[column])), ...(await take())];
    };

    return await take();
  });

const sorted = (ids: readonly (readonly number[])[]): readonly number[] =>
  ids.flat().toSorted((a, b) => a - b);

const upTo = (n: number): readonly number[] =>
  Array.from({ length: n }, (_, i) => i + 1);

describe("claim a job (FOR UPDATE SKIP LOCKED)", () => {
  test("10 workers claim 30 queued jobs concurrently: every job exactly once", async () => {
    await withSchema(async () => {
      await seed(
        stack().connect,
        "INSERT INTO jobs (state) SELECT 'queued' FROM generate_series(1, 30)"
      );

      const claimed = await Promise.all(
        Array.from(
          { length: 10 },
          async (_, worker) =>
            await drain(
              stack().connect,
              claimJob.statements.claim,
              [`worker-${worker}`],
              "id"
            )
        )
      );

      expect(sorted(claimed)).toStrictEqual(upTo(30));
    });
  });
});

describe("write only if nobody wrote first", () => {
  test("of two writers that read version 1, one wins; the loser reads again and wins the next round", async () => {
    await withSchema(async () => {
      await withTwo(stack().connect, async (a, b) => {
        await a.query("INSERT INTO documents (id, body) VALUES (1, 'v1')");

        const won = await one(a, conditionalUpdate.statements.update, [
          1,
          1,
          "from a",
        ]);

        const lost = await one(b, conditionalUpdate.statements.update, [
          1,
          1,
          "from b",
        ]);

        const reread = await one(
          b,
          "SELECT version::int AS version FROM documents WHERE id = 1"
        );

        const retried = await one(b, conditionalUpdate.statements.update, [
          1,
          Number(reread?.version),
          "from b",
        ]);

        expect(won?.version).toBe(2);
        expect(lost).toBeUndefined();
        expect(retried?.version).toBe(3);
      });
    });
  });
});

describe("outbox", () => {
  test("the change and its message commit together, and a rollback removes both", async () => {
    await withSchema(async () => {
      await withTwo(stack().connect, async (session) => {
        const write = async (finish: "COMMIT" | "ROLLBACK") => {
          await session.query("BEGIN");
          await session.query(outbox.statements.insertOrder, ["book"]);
          await session.query(outbox.statements.insertMessage, [
            "order.created",
            '{"item":"book"}',
          ]);
          await session.query(finish);
        };

        const counts = async () => ({
          messages: Number(
            (await one(session, "SELECT count(*)::int AS n FROM outbox"))?.n
          ),
          orders: Number(
            (await one(session, "SELECT count(*)::int AS n FROM orders"))?.n
          ),
        });

        await write("ROLLBACK");
        expect(await counts()).toStrictEqual({ messages: 0, orders: 0 });
        await write("COMMIT");
        expect(await counts()).toStrictEqual({ messages: 1, orders: 1 });
      });
    });
  });

  test("two relays that run at once publish disjoint sets that add up to every message", async () => {
    await withSchema(async () => {
      await seed(
        stack().connect,
        "INSERT INTO outbox (topic, payload) SELECT 't', '{}' FROM generate_series(1, 40)"
      );

      const published = await Promise.all(
        Array.from(
          { length: 2 },
          async () =>
            await drain(stack().connect, outbox.statements.relay, [3], "id")
        )
      );

      expect(sorted(published)).toStrictEqual(upTo(40));
    });
  });
});

describe("pass context to a transaction (set_config with is_local = true)", () => {
  test("is visible inside the transaction and gone for the next client on the same server connection", async () => {
    await withTwo(stack().connect, async (a, b) => {
      await a.query("BEGIN");
      await a.query(transactionContext.statements.set, ["alice"]);

      const inside = await one(a, transactionContext.statements.read);

      await a.query("COMMIT");

      const next = await one(b, transactionContext.statements.read);

      expect(inside?.actor).toBe("alice");
      expect(next?.actor ?? "").toBe("");
    });
  });
});

/** A locks account 1, inside a transaction or not; B, with lock_timeout 300 ms, then updates it. */
const updateWhileLocked = async (
  lockInTransaction: boolean
): Promise<string | undefined> =>
  await withSchema(
    async () =>
      await withTwo(stack().connect, async (a, b) => {
        await a.query("INSERT INTO accounts VALUES (1, 100)");

        if (lockInTransaction) {
          await a.query("BEGIN");
        }

        await a.query("SELECT balance FROM accounts WHERE id = 1 FOR UPDATE");
        await b.query(openingScript({ timeouts: { lockMs: 300 } }));

        const refused = await rejection(
          b.query("UPDATE accounts SET balance = balance - 1 WHERE id = 1")
        );

        await b.query("ROLLBACK");

        if (lockInTransaction) {
          await a.query("ROLLBACK");
        }

        return refused === undefined ? "updated" : failureOf(refused)?.sqlState;
      })
  );

describe("a row lock outside a transaction does not hold", () => {
  test("SELECT ... FOR UPDATE in autocommit is released at the end of its statement, so a second client is not blocked", async () => {
    expect(await updateWhileLocked(false)).toBe("updated");
  });

  test("control: the same lock inside a transaction blocks the second client until lock_timeout (55P03)", async () => {
    expect(await updateWhileLocked(true)).toBe("55P03");
  });
});
