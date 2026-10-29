import { setTimeout as sleep } from "node:timers/promises";

import { classifyFailure, failureOf, openingScript } from "@pg-txmode/core";
import type { FailureKind } from "@pg-txmode/core";
import { describe, expect, test } from "vite-plus/test";

import { pgConnect, rejection } from "../src/index.ts";
import type { Connect, Session } from "../src/index.ts";
import { withSessions } from "../src/probe.ts";
import { useStack } from "./fixtures.ts";

/**
 * The SQLSTATE policy of `@pg-txmode/core` against the errors a real PostgreSQL 18 raises, directly and through PgBouncer:
 * the codes are observed, not remembered.
 */

const stack = useStack(3);

/** What the client sees when `body` fails: the SQLSTATE and the policy's reading of it. */
const failureKind = async (
  body: () => Promise<void>
): Promise<{ kind: FailureKind | undefined; code: string | undefined }> => {
  const caught = await rejection(body());
  const failure = caught === undefined ? undefined : failureOf(caught);

  return { code: failure?.sqlState, kind: failure?.kind };
};

/** Waits until the statement `SELECT pg_sleep(5)` is running somewhere: polls the server, no guessed delay. */
const untilSleeping = async (admin: Session): Promise<void> => {
  const rows = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(5)%' AND state = 'active' AND pid <> pg_backend_pid()"
  );

  if (Number(rows[0]?.n) === 0) {
    await sleep(20);
    await untilSleeping(admin);
  }
};

/**
 * The server's own timers (idle_in_transaction_session_timeout, transaction_timeout) run on its wall clock; the only way to
 * see them fire is to let the time pass, so this test waits for real (a few hundred milliseconds).
 */
const letServerTimerFire = async (): Promise<void> => {
  await sleep(600);
};

const scenarios: readonly {
  readonly name: string;
  readonly expected: { readonly code: string; readonly kind: FailureKind };
  readonly run: (a: Session, b: Session) => Promise<void>;
}[] = [
  {
    expected: { code: "23505", kind: "unique-violation" },
    name: "unique violation",
    run: async (a) => {
      await a.query("CREATE TEMP TABLE u (k int PRIMARY KEY)");
      await a.query("INSERT INTO u VALUES (1)");
      await a.query("INSERT INTO u VALUES (1)");
    },
  },
  {
    expected: { code: "23P01", kind: "exclusion-violation" },
    name: "exclusion violation",
    run: async (a) => {
      await a.query(
        "CREATE TEMP TABLE e (r int4range, EXCLUDE USING gist (r WITH &&))"
      );
      await a.query("INSERT INTO e VALUES ('[1,5)')");
      await a.query("INSERT INTO e VALUES ('[3,7)')");
    },
  },
  {
    expected: { code: "25P02", kind: "in-failed-transaction" },
    name: "a statement after a failed one in the same transaction",
    run: async (a) => {
      await a.query("BEGIN");
      await a.query("SELECT 1/0").catch(() => []);
      await a.query("SELECT 1");
    },
  },
  {
    expected: { code: "25P03", kind: "idle-in-transaction-timeout" },
    name: "idle_in_transaction_session_timeout",
    run: async (a) => {
      await a.query(openingScript({ timeouts: { idleInTransactionMs: 100 } }));
      await letServerTimerFire();
      await a.query("SELECT 1");
    },
  },
  {
    expected: { code: "25P04", kind: "transaction-timeout" },
    name: "transaction_timeout",
    run: async (a) => {
      await a.query(openingScript({ timeouts: { transactionMs: 100 } }));
      await letServerTimerFire();
      await a.query("SELECT 1");
    },
  },
  {
    expected: { code: "55P03", kind: "lock-timeout" },
    name: "lock_timeout",
    run: async (a, b) => {
      await a.query("CREATE TABLE IF NOT EXISTS lock_probe (k int)");
      await a.query("BEGIN");
      await a.query("LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE");
      await b.query(openingScript({ timeouts: { lockMs: 200 } }));

      try {
        await b.query("SELECT * FROM lock_probe");
      } finally {
        await a.query("ROLLBACK");
        await a.query("DROP TABLE lock_probe");
      }
    },
  },
  {
    expected: { code: "57014", kind: "statement-timeout" },
    name: "statement_timeout",
    run: async (a) => {
      await a.query(openingScript({ timeouts: { statementMs: 100 } }));
      await a.query("SELECT pg_sleep(5)");
    },
  },
];

const connections: readonly [string, () => Connect][] = [
  ["directly", () => pgConnect(stack().postgres.endpoint.url)],
  ["through PgBouncer", () => stack().connect],
];

describe.each(connections)(
  "the policy reads the server's errors %s",
  (_name, connectTo) => {
    test.each(scenarios)(
      "$name is $expected.code ($expected.kind)",
      async ({ expected, run }) => {
        const seen = await withSessions(connectTo(), 2, async ([a, b]) =>
          a === undefined || b === undefined
            ? await Promise.reject(new Error("no sessions"))
            : await failureKind(async () => {
                await run(a, b);
              })
        );

        expect(seen).toStrictEqual(expected);
      }
    );

    test("a serialization failure is 40001 and is retryable as a whole", async () => {
      const seen = await withSessions(connectTo(), 2, async ([a, b]) => {
        if (a === undefined || b === undefined) {
          throw new Error("no sessions");
        }

        await a.query(
          "CREATE TABLE IF NOT EXISTS ser_probe (id int PRIMARY KEY, n int)"
        );
        await a.query(
          "INSERT INTO ser_probe VALUES (1, 0), (2, 0) ON CONFLICT DO NOTHING"
        );

        const open = openingScript({ isolation: "serializable" });

        await a.query(open);
        await b.query(open);
        await a.query("SELECT sum(n) FROM ser_probe");
        await b.query("SELECT sum(n) FROM ser_probe");
        await a.query("UPDATE ser_probe SET n = n + 1 WHERE id = 1");
        await b.query("UPDATE ser_probe SET n = n + 1 WHERE id = 2");
        await a.query("COMMIT");

        const error = await rejection(b.query("COMMIT"));

        await a.query("DROP TABLE ser_probe");

        return error === undefined ? undefined : failureOf(error);
      });

      expect(seen).toMatchObject({
        kind: "serialization-failure",
        retry: "whole-transaction",
      });
    });

    test("a cancel arrives as 57014 and is not mistaken for a timeout", async () => {
      const error = await withSessions(
        connectTo(),
        1,
        async ([session]) =>
          await withSessions(
            pgConnect(stack().postgres.endpoint.url),
            1,
            async ([admin]) => {
              if (session === undefined || admin === undefined) {
                throw new Error("no sessions");
              }

              const sleeping = rejection(session.query("SELECT pg_sleep(5)"));

              await untilSleeping(admin);
              await admin.query(
                "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(5)%' AND pid <> pg_backend_pid()"
              );

              return await sleeping;
            }
          )
      );

      expect(
        error === undefined
          ? undefined
          : classifyFailure({
              message: error.message,
              sqlState: failureOf(error)?.sqlState ?? "",
            }).kind
      ).toBe("user-cancel");
    });
  }
);
