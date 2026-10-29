import { setTimeout as sleep } from "node:timers/promises";

import {
  claimJob,
  conditionalUpdate,
  failureOf,
  openingScript,
  outbox,
  outboxDelivery,
  transactionContext,
} from "@pg-txmode/core";
import { describe, expect, test } from "vite-plus/test";

import type { Connect, Session } from "../src/index.ts";
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

  test("a job claimed inside an open transaction is skipped by a second worker, which takes the next job instead of waiting", async () => {
    await withSchema(async () => {
      await seed(
        stack().connect,
        "INSERT INTO jobs (state) SELECT 'queued' FROM generate_series(1, 3)"
      );
      await withTwo(stack().connect, async (a, b) => {
        await a.query("BEGIN");

        const first = await one(a, claimJob.statements.claim, ["a"]);

        await b.query("BEGIN");
        // Without SKIP LOCKED the second claim would wait for the first one's row lock; 500 ms makes that a failure.
        await b.query("SET LOCAL lock_timeout = '500ms'");

        const second = await one(b, claimJob.statements.claim, ["b"]);

        await b.query("COMMIT");
        await a.query("ROLLBACK");
        expect([Number(first?.id), Number(second?.id)]).toStrictEqual([1, 2]);
      });
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
});

const { ack, bury, claimBatch, claimById, release } = outboxDelivery.statements;

const addMessages = async (n: number): Promise<void> => {
  await seed(
    stack().connect,
    `INSERT INTO outbox (topic, payload) SELECT 't', '{}' FROM generate_series(1, ${n})`
  );
};

const stateOf = async (session: Session, id: number) =>
  await one(
    session,
    "SELECT status, attempts, claim_token::text AS token, last_error FROM outbox WHERE id = $1",
    [id]
  );

/** Runs `attempt` until it gives something (the server's own clock decides when a lease lapses), for at most 5 s. */
const until = async <T>(
  attempt: () => Promise<T | undefined>
): Promise<T | undefined> => {
  for (let tries = 0; tries < 100; tries += 1) {
    const found = await attempt();

    if (found !== undefined) {
      return found;
    }

    await sleep(50);
  }

  return undefined;
};

describe("outbox delivery (lease, token, fence)", () => {
  test("four relays that run at once claim disjoint sets that add up to every message", async () => {
    await withSchema(async () => {
      await addMessages(40);

      const claimed = await Promise.all(
        Array.from(
          { length: 4 },
          async () =>
            await drain(stack().connect, claimBatch, [3, 60_000], "id")
        )
      );

      expect(sorted(claimed)).toStrictEqual(upTo(40));
    });
  });

  test("a relay that holds its rows in an open transaction is skipped by a second relay, which takes the next ones instead of waiting", async () => {
    await withSchema(async () => {
      await addMessages(6);
      await withTwo(stack().connect, async (a, b) => {
        await a.query("BEGIN");

        const first = await a.query(claimBatch, [2, 60_000]);

        await b.query("BEGIN");
        // Without SKIP LOCKED the second relay would wait for the first one's row locks; 500 ms makes that a failure.
        await b.query("SET LOCAL lock_timeout = '500ms'");

        const second = await b.query(claimBatch, [2, 60_000]);

        await b.query("COMMIT");
        await a.query("ROLLBACK");
        expect(
          [first, second].map((rows) =>
            sorted([rows.map((row) => Number(row.id))])
          )
        ).toStrictEqual([
          [1, 2],
          [3, 4],
        ]);
      });
    });
  });

  test("a relay that crashes between claim and send does not lose the message: it is claimed again after the lease", async () => {
    await withSchema(async () => {
      await addMessages(1);
      await withTwo(stack().connect, async (crashing, other) => {
        const first = await one(crashing, claimBatch, [1, 300]);

        // The crashing relay never acks. While its lease is live nobody else can take the row.
        expect(await other.query(claimBatch, [1, 60_000])).toStrictEqual([]);

        const again = await until(
          async () => await one(other, claimBatch, [1, 60_000])
        );

        expect(Number(first?.attempts)).toBe(1);
        expect(Number(again?.attempts)).toBe(2);
        expect(again?.claim_token).not.toBe(first?.claim_token);
        expect(
          (await other.query(ack, [1, String(again?.claim_token)])).length
        ).toBe(1);
        expect((await stateOf(other, 1))?.status).toBe("delivered");
      });
    });
  });

  test("control: the at-most-once relay this library used to ship marks the row at claim time, so a crash after it loses the message", async () => {
    await withSchema(async () => {
      await addMessages(1);
      await withTwo(stack().connect, async (crashing, other) => {
        // The old statement: it marked the row published when it claimed it.
        await crashing.query(
          "UPDATE outbox SET status = 'delivered', delivered_at = now() WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING id",
          [1]
        );

        // Nothing was sent, and nothing is left to claim, however long the lease would have been.
        expect(await other.query(claimBatch, [1, 0])).toStrictEqual([]);
        expect((await stateOf(other, 1))?.status).toBe("delivered");
      });
    });
  });

  test("a stale ack, release or bury changes nothing: the lease lapsed, a second relay claimed, then the first one answered", async () => {
    await withSchema(async () => {
      await addMessages(1);
      await withTwo(stack().connect, async (a, b) => {
        const first = await one(a, claimById, [1, 0]);
        const second = await one(b, claimById, [1, 60_000]);
        const stale = String(first?.claim_token);

        expect((await a.query(ack, [1, stale])).length).toBe(0);
        expect((await a.query(release, [1, stale, 0, "timeout"])).length).toBe(
          0
        );
        expect((await a.query(bury, [1, stale, "rejected"])).length).toBe(0);
        expect(await stateOf(a, 1)).toMatchObject({
          attempts: 2,
          status: "pending",
          token: String(second?.claim_token),
        });

        expect(
          (await b.query(ack, [1, String(second?.claim_token)])).length
        ).toBe(1);
        // The same answer twice is also nothing.
        expect(
          (await b.query(ack, [1, String(second?.claim_token)])).length
        ).toBe(0);
        expect((await stateOf(a, 1))?.status).toBe("delivered");
      });
    });
  });

  test("release records the error class and the next attempt waits for its date", async () => {
    await withSchema(async () => {
      await addMessages(1);
      await withTwo(stack().connect, async (a, b) => {
        const claimed = await one(a, claimById, [1, 60_000]);

        expect(
          (
            await a.query(release, [
              1,
              String(claimed?.claim_token),
              3_600_000,
              "timeout",
            ])
          ).length
        ).toBe(1);
        expect(await b.query(claimById, [1, 60_000])).toStrictEqual([]);
        expect((await stateOf(b, 1))?.last_error).toBe("timeout");

        // The retry date arrives: the test moves it, the server's clock is not waited for an hour.
        await b.query("UPDATE outbox SET next_attempt_at = now() WHERE id = 1");

        const retried = await one(b, claimById, [1, 60_000]);

        expect(Number(retried?.attempts)).toBe(2);
      });
    });
  });

  test("a row ends only with a recorded error class, and a dead row is never claimed again", async () => {
    await withSchema(async () => {
      await addMessages(1);
      await withTwo(stack().connect, async (a, b) => {
        const claimed = await one(a, claimById, [1, 60_000]);
        const token = String(claimed?.claim_token);

        const refused = await rejection(a.query(bury, [1, token, null]));

        expect(
          refused === undefined ? undefined : failureOf(refused)?.sqlState
        ).toBe("23514");
        expect((await stateOf(a, 1))?.status).toBe("pending");
        expect((await a.query(bury, [1, token, "rejected"])).length).toBe(1);
        expect(await stateOf(a, 1)).toMatchObject({
          last_error: "rejected",
          status: "dead",
        });
        expect(await b.query(claimById, [1, 0])).toStrictEqual([]);
        expect(await b.query(claimBatch, [5, 0])).toStrictEqual([]);
      });
    });
  });

  test("20 concurrent claims by id of one row give exactly one winner, and the claim uses no SKIP LOCKED", async () => {
    expect(claimById).not.toContain("SKIP LOCKED");

    await withSchema(async () => {
      await addMessages(1);

      const winners = await Promise.all(
        Array.from(
          { length: 20 },
          async () =>
            await withSessions(
              stack().connect,
              1,
              async ([session]) =>
                (await session?.query(claimById, [1, 60_000]))?.length ?? 0
            )
        )
      );

      expect(winners.reduce((sum, n) => sum + n, 0)).toBe(1);
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
