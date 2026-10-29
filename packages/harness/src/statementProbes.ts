import { breaks, works } from "./probe.ts";
import type { Probe } from "./probe.ts";
import { pgConnect } from "./session.ts";
import type { Session } from "./session.ts";
import {
  describeTally,
  failures,
  mergeTallies,
  runClients,
} from "./workload.ts";
import type { Step } from "./workload.ts";

const clients = 8;
const iterations = 100;

const expect = (actual: number | undefined, expected: number) =>
  actual === expected ? "ok" : "wrong";

/** Three parameterised statements in one transaction, each with its own name (or none). */
const transactionStep =
  (named: boolean): Step =>
  async (session, _client, i) => {
    const ask = async (
      name: string,
      text: string
    ): Promise<readonly number[]> =>
      await (
        named ? session.queryNamed(name, text, [i]) : session.query(text, [i])
      ).then((rows) => rows.map((row) => Number(row.v)));

    await session.query("BEGIN");

    const [plus] = await ask("txmode_plus", "SELECT $1::int + 1 AS v");
    const [times] = await ask("txmode_times", "SELECT $1::int * 2 AS v");

    await session.query("COMMIT");

    return expect(plus, i + 1) === "ok" && expect(times, i * 2) === "ok"
      ? "ok"
      : "wrong";
  };

/** Every client uses one statement name for its own text: the answer shows whose SQL ran. */
const sharedNameStep: Step = async (session: Session, client, i) => {
  const rows = await session.queryNamed(
    "txmode_shared",
    `SELECT ${client}::int AS v, $1::int AS i`,
    [i]
  );

  return Number(rows[0]?.v) === client && Number(rows[0]?.i) === i
    ? "ok"
    : "wrong";
};

/**
 * Protocol-level named statements, with PgBouncer tracking them (`max_prepared_statements` above 0) or not (0).
 * Untracked, a name belongs to the server connection that parsed it: clients fail with 42P05 (already exists) and 26000
 * (does not exist), and clients that share a name run each other's SQL. This is the pinned known issue of the catalogue
 * row `named-statements-untracked`; the hang of report M2b was measured with another client and is not reproduced.
 */
const namedStatementProbe = (
  id: string,
  maxPreparedStatements: number
): Probe => ({
  id,
  maxPreparedStatements,
  poolSize: 3,
  run: async ({ connect }) => {
    const tally = mergeTallies([
      await runClients(connect, clients, iterations, transactionStep(true)),
      await runClients(connect, clients, iterations, sharedNameStep),
    ]);

    const detail = `max_prepared_statements=${maxPreparedStatements}: ${describeTally(tally)}`;

    return failures(tally) === 0 ? works(detail) : breaks(detail);
  },
});

export const statementProbes: readonly Probe[] = [
  namedStatementProbe("named-statement-tracked", 1000),
  namedStatementProbe("known-issue-named-statements", 0),
  {
    id: "unnamed-statements",
    maxPreparedStatements: 0,
    poolSize: 3,
    run: async ({ connect }) => {
      const tally = await runClients(
        connect,
        clients,
        iterations,
        transactionStep(false)
      );

      const detail = `max_prepared_statements=0, unnamed statements: ${describeTally(tally)}`;

      return failures(tally) === 0 ? works(detail) : breaks(detail);
    },
  },
  {
    // Each client writes 50 queries without waiting for an answer (node-postgres `pipeline: true`).
    id: "pipelining",
    maxPreparedStatements: 1000,
    poolSize: 3,
    run: async ({ endpoint }) => {
      const connect = pgConnect(endpoint.url, { pipeline: true });

      const tally = await runClients(connect, 16, 1, async (session) => {
        const answers = await Promise.all(
          Array.from(
            { length: 50 },
            async (_, n) =>
              await session
                .query("SELECT $1::int AS v", [n])
                .then((rows) => Number(rows[0]?.v))
          )
        );

        return answers.every((answer, n) => answer === n) ? "ok" : "wrong";
      });

      const detail = `16 clients x 50 queries in flight: ${describeTally(tally)}`;

      return failures(tally) === 0 ? works(detail) : breaks(detail);
    },
  },
];
