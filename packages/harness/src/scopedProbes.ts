import { leaks, withPair, works } from "./probe.ts";
import type { Observation, Probe } from "./probe.ts";
import type { Session } from "./session.ts";

/** The probes of the constructs that are safe because their state ends with the transaction. */

const first = async (session: Session, sql: string): Promise<string> =>
  String((await session.query(sql))[0]?.v);

/** A probe of two clients: the first acts, the second looks. */
const pairProbe = (
  id: string,
  poolSize: number,
  body: (a: Session, b: Session) => Promise<Observation>
): Probe => ({
  id,
  maxPreparedStatements: 1000,
  poolSize,
  run: async ({ connect }) => await withPair(connect, body),
});

const setLocal = pairProbe("scoped-set-local", 1, async (a, b) => {
  await a.query("BEGIN");
  await a.query("SET LOCAL statement_timeout = '7s'");

  const inside = await first(
    a,
    "SELECT current_setting('statement_timeout') AS v"
  );

  await a.query("COMMIT");

  const after = await first(
    b,
    "SELECT current_setting('statement_timeout') AS v"
  );

  const detail = `inside: statement_timeout=${inside}; next client after COMMIT: statement_timeout=${after}`;

  return inside === "7s" && after === "0" ? works(detail) : leaks(detail);
});

const setConfigLocal = pairProbe("scoped-set-config-local", 1, async (a, b) => {
  await a.query("BEGIN");
  await a.query("SELECT set_config('app.local_probe', 'alice', true)");

  const actor = await first(
    a,
    "SELECT current_setting('app.local_probe') AS v"
  );

  await a.query("COMMIT");

  const actorAfter = await first(
    b,
    "SELECT coalesce(current_setting('app.local_probe', true), '') AS v"
  );

  const detail = `inside: actor=${actor}; next client after COMMIT: actor='${actorAfter}'`;

  return actor === "alice" && actorAfter === "" ? works(detail) : leaks(detail);
});

/** A transaction-level advisory lock excludes another client while the transaction is open and ends with it. */
const advisoryXact = pairProbe("scoped-advisory-xact", 2, async (a, b) => {
  const tryLock = "SELECT pg_try_advisory_xact_lock(7) AS v";

  await a.query("BEGIN");
  await a.query("SELECT pg_advisory_xact_lock(7)");
  await b.query("BEGIN");

  const whileHeld = await first(b, tryLock);

  await b.query("COMMIT");
  await a.query("COMMIT");
  await b.query("BEGIN");

  const afterRelease = await first(b, tryLock);

  await b.query("COMMIT");

  const detail = `B's try while A's transaction is open: ${whileHeld}; after A's COMMIT: ${afterRelease}`;

  return whileHeld === "false" && afterRelease === "true"
    ? works(detail)
    : leaks(detail);
});

const tempOnCommitDrop = pairProbe(
  "scoped-temp-on-commit-drop",
  1,
  async (a, b) => {
    await a.query("BEGIN");
    await a.query("CREATE TEMP TABLE drop_probe (a int) ON COMMIT DROP");
    await a.query("INSERT INTO drop_probe VALUES (1), (2)");

    const inside = await first(a, "SELECT count(*)::int AS v FROM drop_probe");

    await a.query("COMMIT");

    const after = await first(
      b,
      "SELECT to_regclass('pg_temp.drop_probe') IS NOT NULL AS v"
    );

    const detail = `rows inside the transaction: ${inside}; table visible to the next client after COMMIT: ${after}`;

    return inside === "2" && after === "false" ? works(detail) : leaks(detail);
  }
);

const cursorInTransaction = pairProbe(
  "scoped-cursor-in-transaction",
  1,
  async (a, b) => {
    await a.query("BEGIN");
    await a.query(
      "DECLARE scoped_probe CURSOR FOR SELECT generate_series(1, 10) AS n"
    );

    const fetched = (await a.query("FETCH 3 FROM scoped_probe")).length;

    await a.query("COMMIT");

    const after = await first(
      b,
      "SELECT count(*)::int AS v FROM pg_cursors WHERE name = 'scoped_probe'"
    );

    const detail = `rows fetched inside the transaction: ${fetched}; cursors left for the next client: ${after}`;

    return fetched === 3 && after === "0" ? works(detail) : leaks(detail);
  }
);

export const scopedProbes: readonly Probe[] = [
  setLocal,
  setConfigLocal,
  advisoryXact,
  tempOnCommitDrop,
  cursorInTransaction,
];
