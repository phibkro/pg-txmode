import {
  claim,
  claimJob,
  dropExampleSchema,
  exampleSchema,
  failureOf,
  openingScript,
  outbox,
  outboxDelivery,
  rowLock,
  savepoint,
  withTransactionRetry,
} from "@pg-txmode/core";
import type { Failure } from "@pg-txmode/core";

import { breaks, withSessions, works } from "./probe.ts";
import type { Probe, Target } from "./probe.ts";
import { pgConnect, rejection } from "./session.ts";
import type { Session } from "./session.ts";
import { inSequence } from "./workload.ts";

/**
 * The positive constructs of `@pg-txmode/core`, run on the pooler: every probe here executes the SQL the library
 * ships, concurrently, through the pooler and against PostgreSQL itself, and checks the invariant the pattern promises.
 */

/** Creates the example tables in PostgreSQL itself (not through the pooler), runs `use`, and drops them. */
export const withExampleSchema = async <T>(
  target: Target,
  use: () => Promise<T>
): Promise<T> =>
  await withSessions(pgConnect(target.direct.url), 1, async ([admin]) => {
    await inSequence(
      exampleSchema,
      async (sql) => await (admin?.query(sql) ?? Promise.resolve([]))
    );

    try {
      return await use();
    } finally {
      await admin?.query(dropExampleSchema);
    }
  });

const count = async (session: Session, sql: string): Promise<number> =>
  Number((await session.query(sql))[0]?.n);

const inTransaction = async <T>(
  session: Session,
  body: () => Promise<T>
): Promise<T> => {
  await session.query("BEGIN");

  const result = await body();

  await session.query("COMMIT");

  return result;
};

/** 20 clients each try to withdraw 300 from 1000: exactly 3 succeed, the balance ends at 100, never below 0. */
const rowLockProbe: Probe = {
  id: "pattern-row-lock",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(target, async () => {
      await withSessions(
        target.connect,
        1,
        async ([seed]) =>
          await seed?.query("INSERT INTO accounts VALUES (1, 1000)")
      );

      // Each client reads the balance, thinks for 20 ms, then writes: without the row lock two clients read the same
      // balance and the second write breaks the CHECK (balance >= 0).
      const attempts = await Promise.allSettled(
        Array.from(
          { length: 20 },
          async () =>
            await withSessions(target.connect, 1, async ([session]) =>
              session === undefined
                ? false
                : await inTransaction(session, async () => {
                    const rows = await session.query(
                      rowLock.statements.lock,
                      [1]
                    );

                    const enough = Number(rows[0]?.balance) >= 300;

                    await session.query("SELECT pg_sleep(0.02)");

                    if (enough) {
                      await session.query(
                        rowLock.statements.withdraw,
                        [1, 300]
                      );
                    }

                    return enough;
                  })
            )
        )
      );

      const succeeded = attempts.filter(
        (attempt) => attempt.status === "fulfilled" && attempt.value
      ).length;

      const refused = attempts.filter(
        (attempt) => attempt.status === "rejected"
      ).length;

      const balance = await withSessions(
        target.connect,
        1,
        async ([session]) =>
          session === undefined
            ? -1
            : await count(
                session,
                "SELECT balance::int AS n FROM accounts WHERE id = 1"
              )
      );

      const detail = `20 concurrent withdrawals of 300 from 1000: ${succeeded} succeeded, ${refused} failed, final balance ${balance}`;

      return succeeded === 3 && refused === 0 && balance === 100
        ? works(detail)
        : breaks(detail);
    }),
};

/**
 * Worker A claims a row inside an open transaction; worker B, in another, must take the next row instead of waiting. Once
 * with the job claim, once with the outbox's `claimBatch`: both are `FOR UPDATE SKIP LOCKED` statements.
 */
const skipsHeldRow = async (
  a: Session,
  b: Session,
  claimSql: string,
  firstArgs: readonly (string | number)[],
  secondArgs: readonly (string | number)[]
): Promise<string | undefined> => {
  await a.query("BEGIN");

  const first = await a.query(claimSql, firstArgs);

  await b.query("BEGIN");
  // Without SKIP LOCKED the second claim waits for the first one's row lock; 500 ms turns that into a failure.
  await b.query("SET LOCAL lock_timeout = '500ms'");

  const [second] = await Promise.allSettled([b.query(claimSql, secondArgs)]);

  await a.query("ROLLBACK");
  await b.query("ROLLBACK");

  const detail =
    second?.status === "fulfilled"
      ? `worker A holds row ${first[0]?.id} in an open transaction; worker B took row ${second.value[0]?.id}`
      : `worker B did not get a row: ${second?.reason}`;

  return second?.status === "fulfilled" &&
    Number(first[0]?.id) === 1 &&
    Number(second.value[0]?.id) === 2
    ? undefined
    : detail;
};

const skipLockedProbe: Probe = {
  id: "pattern-skip-locked",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(
      target,
      async () =>
        await withSessions(target.connect, 2, async ([a, b]) => {
          if (a === undefined || b === undefined) {
            return breaks("no sessions");
          }

          await a.query(
            "INSERT INTO jobs (state) SELECT 'queued' FROM generate_series(1, 3)"
          );
          await a.query(
            "INSERT INTO outbox (topic, payload) SELECT 't', '{}' FROM generate_series(1, 3)"
          );

          const jobs = await skipsHeldRow(
            a,
            b,
            claimJob.statements.claim,
            ["a"],
            ["b"]
          );

          const outboxRows = await skipsHeldRow(
            a,
            b,
            outboxDelivery.statements.claimBatch,
            [1, 60_000],
            [1, 60_000]
          );

          const detail =
            "worker A claims row 1 in an open transaction; worker B, in another, takes row 2 without waiting: the job claim and the outbox claimBatch";

          return jobs === undefined && outboxRows === undefined
            ? works(detail)
            : breaks(
                `jobs: ${jobs ?? "ok"}; claimBatch: ${outboxRows ?? "ok"}`
              );
        })
    ),
};

/** 20 clients claim one key: one row comes back, one row exists. */
const onConflictClaimProbe: Probe = {
  id: "pattern-on-conflict-claim",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(target, async () => {
      const winners = await Promise.all(
        Array.from(
          { length: 20 },
          async (_, owner) =>
            await withSessions(
              target.connect,
              1,
              async ([session]) =>
                (
                  await session?.query(claim.statements.claim, [
                    "only",
                    `owner-${owner}`,
                  ])
                )?.length ?? 0
            )
        )
      );

      const rows = await withSessions(target.connect, 1, async ([session]) =>
        session === undefined
          ? -1
          : await count(session, "SELECT count(*)::int AS n FROM claims")
      );

      const won = winners.reduce((sum, n) => sum + n, 0);
      const detail = `20 concurrent claims of one key: ${won} got the row back, ${rows} row(s) stored`;

      return won === 1 && rows === 1 ? works(detail) : breaks(detail);
    }),
};

const savepointProbe: Probe = {
  id: "pattern-savepoint",
  maxPreparedStatements: 1000,
  poolSize: 1,
  run: async (target) =>
    await withExampleSchema(
      target,
      async () =>
        await withSessions(target.connect, 1, async ([session]) => {
          if (session === undefined) {
            return breaks("no session");
          }

          await session.query("BEGIN");
          await session.query(
            "INSERT INTO documents (id, body) VALUES (1, 'outer')"
          );
          await session.query(savepoint.statements.open);
          await session.query(
            "INSERT INTO documents (id, body) VALUES (3, 'inner, undone')"
          );

          const failed = (
            await rejection(
              session.query(
                "INSERT INTO documents (id, body) VALUES (1, 'duplicate')"
              )
            )
          )?.message;

          await session.query(savepoint.statements.rollback);
          await session.query(
            "INSERT INTO documents (id, body) VALUES (2, 'after')"
          );
          await session.query(savepoint.statements.release);
          await session.query("COMMIT");

          const ids = (
            await session.query("SELECT id FROM documents ORDER BY id")
          ).map((row) => Number(row.id));

          const detail = `the duplicate failed (${failed}); committed ids ${JSON.stringify(ids)}`;

          return JSON.stringify(ids) === "[1,2]"
            ? works(detail)
            : breaks(detail);
        })
    ),
};

/** The first half of the write skew: read the total, then write one's own row. */
const skewWrite = async (session: Session, id: number): Promise<void> => {
  await session.query(openingScript({ isolation: "serializable" }));
  await session.query("SELECT sum(balance)::int AS n FROM accounts");
  await session.query(
    "UPDATE accounts SET balance = balance + 1 WHERE id = $1",
    [id]
  );
};

const outcomeOf = (error: Error | undefined, success: string): string =>
  error === undefined ? success : (failureOf(error)?.sqlState ?? error.message);

/** Two serializable transactions with the classic write skew: exactly one is refused with 40001. */
const serializationConflict = async (target: Target): Promise<string[]> =>
  await withSessions(target.connect, 2, async ([a, b]) => {
    if (a === undefined || b === undefined) {
      return ["no sessions"];
    }

    await a.query("INSERT INTO accounts VALUES (1, 0), (2, 0)");

    const written = await Promise.all([
      rejection(skewWrite(a, 1)),
      rejection(skewWrite(b, 2)),
    ]);

    const committed = await Promise.all(
      [a, b].map(async (session) => await rejection(session.query("COMMIT")))
    );

    return [
      ...written.map((error) => outcomeOf(error, "written")),
      ...committed.map((error) => outcomeOf(error, "committed")),
    ];
  });

const isolationProbe: Probe = {
  id: "pattern-isolation",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(target, async () => {
      const outcomes = await serializationConflict(target);

      const refused = outcomes.filter((outcome) => outcome.includes("40001"));

      const settings = await withSessions(
        target.connect,
        1,
        async ([session]) => {
          if (session === undefined) {
            return "";
          }

          await session.query(
            openingScript({
              isolation: "repeatable read",
              timeouts: { statementMs: 5000 },
            })
          );

          const rows = await session.query(
            "SELECT current_setting('transaction_isolation') AS iso, current_setting('statement_timeout') AS timeout"
          );

          await session.query("ROLLBACK");

          return `${rows[0]?.iso}, statement_timeout ${rows[0]?.timeout}`;
        }
      );

      const detail = `BEGIN ISOLATION LEVEL REPEATABLE READ plus SET LOCAL in one script: ${settings}; two serializable write-skew transactions: ${JSON.stringify(outcomes)}`;

      return settings === "repeatable read, statement_timeout 5s" &&
        refused.length >= 1
        ? works(detail)
        : breaks(detail);
    }),
};

/** A barrier for two contenders: `meet(me)` resolves once the other has arrived too. Later calls pass at once. */
const barrier = (): ((me: 0 | 1) => Promise<null>) => {
  const arrived = [
    Promise.withResolvers<null>(),
    Promise.withResolvers<null>(),
  ] as const;

  return async (me) => {
    arrived[me].resolve(null);

    return await arrived[me === 0 ? 1 : 0].promise;
  };
};

const retryPolicy = {
  baseDelayMs: 5,
  maxAttempts: 8,
  maxDelayMs: 50,
  retryDeadlocks: true,
};

/** One contender: the whole transaction (`work`, then COMMIT) under `withTransactionRetry`, rolled back when it fails. */
const contend = async (
  target: Target,
  onRetry: (failure: Failure) => void,
  work: (session: Session) => Promise<void>
): Promise<null> =>
  await withSessions(
    target.connect,
    1,
    async ([session]) =>
      await withTransactionRetry(
        async () => {
          if (session === undefined) {
            throw new Error("no session");
          }

          try {
            await work(session);
            await session.query("COMMIT");

            return null;
          } catch (error) {
            await session.query("ROLLBACK").catch(() => []);
            throw error;
          }
        },
        { onRetry, policy: retryPolicy }
      )
  );

/**
 * Two transactions that conflict on purpose, once as a deadlock and once as a serialization failure, each run by
 * `withTransactionRetry`: both commit, and each failure kind was retried at least once.
 */
const retryProbe: Probe = {
  id: "pattern-retry",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(target, async () => {
      const retried: Failure[] = [];

      const onRetry = (failure: Failure): void => {
        retried.push(failure);
      };

      await withSessions(
        target.connect,
        1,
        async ([seed]) =>
          await seed?.query("INSERT INTO accounts VALUES (1, 0), (2, 0)")
      );

      // Deadlock: each locks its own row, waits for the other to do the same, then asks for the other's row.
      const lockMeet = barrier();

      const crossing = async (me: 0 | 1): Promise<null> =>
        await contend(target, onRetry, async (session) => {
          const other = me === 0 ? 2 : 1;

          await session.query("BEGIN");
          await session.query("SET LOCAL deadlock_timeout = '50ms'");
          await session.query(
            "SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE",
            [me + 1]
          );
          await lockMeet(me);
          await session.query(
            "SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE",
            [other]
          );
        });

      await Promise.all([crossing(0), crossing(1)]);

      // Serialization failure: each reads the total, waits for the other to read it, then writes its own row.
      const readMeet = barrier();

      const skewing = async (me: 0 | 1): Promise<null> =>
        await contend(target, onRetry, async (session) => {
          await session.query(openingScript({ isolation: "serializable" }));
          await session.query("SELECT sum(balance)::int AS n FROM accounts");
          await readMeet(me);
          await session.query(
            "UPDATE accounts SET balance = balance + 1 WHERE id = $1",
            [me + 1]
          );
        });

      await Promise.all([skewing(0), skewing(1)]);

      const kinds = retried.map((failure) => failure.kind);

      const total = await withSessions(target.connect, 1, async ([session]) =>
        session === undefined
          ? -1
          : await count(session, "SELECT sum(balance)::int AS n FROM accounts")
      );

      const detail = `retried: ${JSON.stringify(kinds)}; final total ${total}`;

      return kinds.includes("deadlock-detected") &&
        kinds.includes("serialization-failure") &&
        total === 2
        ? works(detail)
        : breaks(detail);
    }),
};

const outboxState = async (session: Session): Promise<string> => {
  const [row] = await session.query(
    "SELECT status, attempts, claim_token::text AS token FROM outbox WHERE id = 1"
  );

  return `${row?.status} attempts ${row?.attempts} token ${row?.token === null ? "none" : "set"}`;
};

/**
 * The delivery half of the outbox, through the pooler: a worker that claims and never acks (a crash) leaves the row to be
 * claimed again once the lease has lapsed; the first worker's late ack then matches nothing; 20 concurrent claims by id
 * give exactly one winner. The lease of the "crashed" claim is 0 ms, so it has lapsed by the next statement.
 */
const outboxLeaseProbe: Probe = {
  id: "pattern-outbox-lease",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withExampleSchema(target, async () => {
      const { ack, claimById } = outboxDelivery.statements;

      const sequence = await withSessions(target.connect, 2, async ([a, b]) => {
        if (a === undefined || b === undefined) {
          return "no sessions";
        }

        await a.query(outbox.statements.insertMessage, ["t", "{}"]);

        const first = await a.query(claimById, [1, 0]);
        const second = await b.query(claimById, [1, 60_000]);
        const lateAck = await a.query(ack, [1, first[0]?.claim_token ?? ""]);
        const afterLateAck = await outboxState(a);
        const ack2 = await b.query(ack, [1, second[0]?.claim_token ?? ""]);

        return `A claimed (attempts ${first[0]?.attempts}); B claimed after the lapsed lease (attempts ${second[0]?.attempts}); A's late ack matched ${lateAck.length} row(s), state then: ${afterLateAck}; B's ack matched ${ack2.length}; final: ${await outboxState(a)}`;
      });

      const winners = await withSessions(target.connect, 1, async ([seed]) => {
        await seed?.query(outbox.statements.insertMessage, ["t", "{}"]);

        return await Promise.all(
          Array.from(
            { length: 20 },
            async () =>
              await withSessions(
                target.connect,
                1,
                async ([session]) =>
                  (await session?.query(claimById, [2, 60_000]))?.length ?? 0
              )
          )
        );
      });

      const won = winners.reduce((sum, n) => sum + n, 0);
      const detail = `${sequence}; 20 concurrent claims by id of one row: ${won} winner(s)`;

      return sequence ===
        "A claimed (attempts 1); B claimed after the lapsed lease (attempts 2); A's late ack matched 0 row(s), state then: pending attempts 2 token set; B's ack matched 1; final: delivered attempts 2 token none" &&
        won === 1
        ? works(detail)
        : breaks(detail);
    }),
};

export const patternProbes: readonly Probe[] = [
  rowLockProbe,
  skipLockedProbe,
  outboxLeaseProbe,
  onConflictClaimProbe,
  savepointProbe,
  isolationProbe,
  retryProbe,
];
