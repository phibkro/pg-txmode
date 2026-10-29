import { setTimeout as sleep } from "node:timers/promises";

import { failureOf, hyperdrive, pgBouncer, rowLock } from "@pg-txmode/core";
import type { Failure } from "@pg-txmode/core";
import { rejection, startStack } from "@pg-txmode/harness";
import type { Stack } from "@pg-txmode/harness";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createDatabase, TransactionAbortedError } from "../src/index.ts";
import type { TxClient } from "../src/index.ts";

/**
 * `transaction`: one connection, the whole body, opened in one round trip, retried as a whole, rolled back when the
 * request goes away. Everything runs through the harness's PgBouncer with two server connections.
 */

/** Waits until `SELECT pg_sleep(5)` is running somewhere: polls the server, no guessed delay. */
const untilRunning = async (client: TxClient): Promise<void> => {
  const rows = await client.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(5)%' AND state = 'active' AND pid <> pg_backend_pid()"
  );

  if (Number(rows[0]?.n) === 0) {
    await sleep(20);
    await untilRunning(client);
  }
};

let stack: Stack;
let db: TxClient;
let observer: TxClient;

beforeAll(async () => {
  stack = await startStack(2);
  db = createDatabase({
    connectionString: stack.pooler.endpoint.url,
    mode: pgBouncer(1000),
  });
  observer = createDatabase({
    connectionString: stack.postgres.endpoint.url,
    mode: hyperdrive,
  });
  await observer.query(
    "CREATE TABLE account (id int PRIMARY KEY, balance int NOT NULL CHECK (balance >= 0)); CREATE TABLE note (k int PRIMARY KEY)"
  );
}, 60_000);

afterAll(async () => {
  await db.end();
  await observer.end();
  await stack.stop();
});

const failureKind = async (
  promise: Promise<unknown>
): Promise<string | undefined> => {
  const error = await rejection(promise);

  return error === undefined ? undefined : failureOf(error)?.kind;
};

/** Two parties wait for each other; a later call (a retry) passes at once. */
const meeting = () => {
  const arrived = [
    Promise.withResolvers<null>(),
    Promise.withResolvers<null>(),
  ] as const;

  return async (me: 0 | 1): Promise<null> => {
    arrived[me].resolve(null);

    return await arrived[me === 0 ? 1 : 0].promise;
  };
};

describe("one transaction", () => {
  test("commits what the body wrote, and rolls back what a failing body wrote", async () => {
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO note VALUES (1)");
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO note VALUES (2)");

        throw new Error("the body failed");
      })
    ).rejects.toThrow("the body failed");

    expect(
      (await observer.query("SELECT k FROM note ORDER BY k")).map((row) =>
        Number(row.k)
      )
    ).toStrictEqual([1]);
  });

  test("opens with the isolation level and the timeouts in one script", async () => {
    const seen = await db.transaction(
      async (tx) =>
        (
          await tx.query(
            "SELECT current_setting('transaction_isolation') AS iso, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock"
          )
        )[0],
      {
        isolation: "repeatable read",
        timeouts: { lockMs: 250, statementMs: 3000 },
      }
    );

    expect(seen).toStrictEqual({
      iso: "repeatable read",
      lock: "250ms",
      statement: "3s",
    });
  });

  test("a statement timeout ends the transaction as a timeout, once, and the next transaction is clean", async () => {
    let runs = 0;

    const kind = await failureKind(
      db.transaction(
        async (tx) => {
          runs += 1;
          await tx.query("SELECT pg_sleep(5)");
        },
        { timeouts: { statementMs: 100 } }
      )
    );

    expect(kind).toBe("statement-timeout");
    expect(runs).toBe(1);
    expect(
      await db.transaction(async (tx) =>
        String((await tx.query("SHOW statement_timeout"))[0]?.statement_timeout)
      )
    ).toBe("0");
  });

  test("a failure that the policy does not retry runs the body once", async () => {
    let runs = 0;

    await observer.query("INSERT INTO note VALUES (10)");

    const kind = await failureKind(
      db.transaction(async (tx) => {
        runs += 1;
        await tx.query("INSERT INTO note VALUES (10)");
      })
    );

    expect([kind, runs]).toStrictEqual(["unique-violation", 1]);
  });
});

describe("whole-transaction retry", () => {
  test("a serialization failure and a deadlock each run the whole body again, and both transactions commit", async () => {
    await observer.query("INSERT INTO account VALUES (1, 0), (2, 0)");

    const retried: Failure[] = [];

    const onRetry = (failure: Failure): void => {
      retried.push(failure);
    };

    const crossed = meeting();
    const read = meeting();

    const deadlocking = async (me: 0 | 1) => {
      await db.transaction(
        async (tx) => {
          await tx.query("SET LOCAL deadlock_timeout = '50ms'");
          await tx.query("SELECT 1 FROM account WHERE id = $1 FOR UPDATE", [
            me + 1,
          ]);
          await crossed(me);
          await tx.query("SELECT 1 FROM account WHERE id = $1 FOR UPDATE", [
            2 - me,
          ]);
        },
        { onRetry, sleep: async () => {} }
      );
    };

    const skewing = async (me: 0 | 1) => {
      await db.transaction(
        async (tx) => {
          await tx.query("SELECT sum(balance) FROM account");
          await read(me);
          await tx.query(
            "UPDATE account SET balance = balance + 1 WHERE id = $1",
            [me + 1]
          );
        },
        { isolation: "serializable", onRetry, sleep: async () => {} }
      );
    };

    await Promise.all([deadlocking(0), deadlocking(1)]);
    await Promise.all([skewing(0), skewing(1)]);

    expect(retried.map((failure) => failure.kind)).toContain(
      "deadlock-detected"
    );
    expect(retried.map((failure) => failure.kind)).toContain(
      "serialization-failure"
    );
    expect(
      (await observer.query("SELECT sum(balance)::int AS n FROM account"))[0]?.n
    ).toBe(2);
  });

  test("the body is told which attempt it is, and `retry: false` runs it once", async () => {
    const attempts: number[] = [];
    const clash = meeting();

    const run = async (me: 0 | 1) => {
      await db.transaction(
        async (tx) => {
          attempts.push(tx.attempt);
          await tx.query("SELECT sum(balance) FROM account");
          await clash(me);
          await tx.query(
            "UPDATE account SET balance = balance + 1 WHERE id = $1",
            [me + 1]
          );
        },
        { isolation: "serializable", retry: false }
      );
    };

    const outcomes = await Promise.allSettled([run(0), run(1)]);

    expect(attempts).toStrictEqual([1, 1]);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected")
    ).toHaveLength(1);
  });
});

/** A transaction that inserts `key`, says so, and then keeps the connection busy for 30 seconds. */
const insertAndWait = async (
  client: TxClient,
  key: number,
  ready: () => void,
  signal: AbortSignal
) => {
  await client.transaction(
    async (tx) => {
      await tx.query("INSERT INTO note VALUES ($1)", [key]);
      ready();
      await tx.query("SELECT pg_sleep(30)");
    },
    { retry: false, signal }
  );
};

describe("a transaction does not outlive its request", () => {
  test("an abort mid-transaction closes the connection; the server rolls back and the lock is free", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<null>();

    const running = rejection(
      insertAndWait(
        db,
        100,
        () => {
          started.resolve(null);
        },
        controller.signal
      )
    );

    await started.promise;
    controller.abort();

    const error = await running;

    expect(error).toBeInstanceOf(TransactionAbortedError);
    expect(error).toMatchObject({ outcomeUnknown: false });

    // The key was rolled back with the transaction: inserting it again does not wait for a lock and finds no row.
    await observer.transaction(
      async (tx) => {
        await tx.query("INSERT INTO note VALUES (100)");
      },
      { timeouts: { lockMs: 2000 } }
    );
  });

  test("control: closing the socket alone, while a statement runs, leaves the lock held (why the adapter cancels first)", async () => {
    const client = new Client({ connectionString: stack.pooler.endpoint.url });

    client.on("error", () => {
      // the socket is destroyed on purpose
    });
    await client.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO note VALUES (300)");
    client.query("SELECT pg_sleep(5)").catch(() => {});
    await untilRunning(observer);
    client.connection.stream.destroy();

    // Without a cancel the backend keeps running pg_sleep(5) and holds the lock on key 300: a second insert times out.
    expect(
      await failureKind(
        observer.transaction(
          async (tx) => {
            await tx.query("INSERT INTO note VALUES (300)");
          },
          { retry: false, timeouts: { lockMs: 300 } }
        )
      )
    ).toBe("lock-timeout");
  });

  test("a signal that is already aborted never opens a transaction", async () => {
    const controller = new AbortController();

    controller.abort();

    const error = await rejection(
      db.transaction(async () => {}, { signal: controller.signal })
    );

    expect(error).toMatchObject({
      name: "TransactionAbortedError",
      outcomeUnknown: false,
    });
  });

  test("an abort while COMMIT is on the wire is reported as an unknown outcome", async () => {
    await observer.query(
      `CREATE FUNCTION slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$;
       CREATE CONSTRAINT TRIGGER slow_commit AFTER INSERT ON note DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slow_commit()`
    );

    const controller = new AbortController();
    const bodyDone = Promise.withResolvers<null>();

    const running = rejection(
      db.transaction(
        async (tx) => {
          await tx.query("INSERT INTO note VALUES (200)");
          bodyDone.resolve(null);
        },
        { retry: false, signal: controller.signal }
      )
    );

    await bodyDone.promise;
    // The server's deferred trigger holds COMMIT for a second; the abort arrives while it does. Real time: the body's end
    // and the COMMIT message are one event loop turn apart, and 200 ms is far inside the trigger's second.
    await sleep(200);
    controller.abort();

    expect(await running).toMatchObject({
      name: "TransactionAbortedError",
      outcomeUnknown: true,
    });
    await observer.query("DROP TRIGGER slow_commit ON note");
  });
});

describe("the server ends the session itself", () => {
  test("the SQLSTATE of an idle-in-transaction timeout reaches the caller, and the body is not retried", async () => {
    let runs = 0;

    const kind = await failureKind(
      db.transaction(
        async (tx) => {
          runs += 1;
          await tx.query("SELECT 1");
          // The server's own timer (100 ms) must fire while the body idles inside the transaction: real time, 600 ms.
          await sleep(600);
          await tx.query("SELECT 2");
        },
        { timeouts: { idleInTransactionMs: 100 } }
      )
    );

    expect([kind, runs]).toStrictEqual(["idle-in-transaction-timeout", 1]);
  });
});

describe("concurrency through the adapter", () => {
  test("20 withdrawals with the row-lock pattern keep the balance exact", async () => {
    await observer.query("INSERT INTO account VALUES (9, 1000)");

    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          await db.transaction(async (tx) => {
            const [row] = await tx.query(
              rowLock.statements.lock.replace("accounts", "account"),
              [9]
            );

            const enough = Number(row?.balance) >= 300;

            await tx.query("SELECT pg_sleep(0.02)");

            if (enough) {
              await tx.query(
                rowLock.statements.withdraw.replace("accounts", "account"),
                [9, 300]
              );
            }

            return enough;
          })
      )
    );

    expect(results.filter(Boolean)).toHaveLength(3);
    expect(
      (await observer.query("SELECT balance FROM account WHERE id = 9"))[0]
        ?.balance
    ).toBe(100);
  });
});
