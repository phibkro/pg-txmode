import { leaks, withPair, works } from "./probe.ts";
import type { Probe } from "./probe.ts";

/**
 * M1 of the research report, as probes: client A changes session state, client B (a different connection to the same
 * endpoint) looks for it. With one server connection behind the pooler B is on A's session; a direct connection gives B
 * its own. `leaks` means B saw A's state.
 */
interface Leak {
  readonly id: string;
  /** What A runs, on its own and outside any transaction block of the probe's making. */
  readonly set: string;
  /** What B runs; its first row has a boolean `seen`. */
  readonly look: string;
  readonly what: string;
}

const leakProbe = (leak: Leak): Probe => ({
  id: leak.id,
  maxPreparedStatements: 1000,
  poolSize: 1,
  run: async ({ connect }) =>
    await withPair(connect, async (a, b) => {
      await a.query(leak.set);

      const seen = (await b.query(leak.look))[0]?.seen === true;

      return seen
        ? leaks(`client B saw ${leak.what}`)
        : works(`client B did not see ${leak.what}`);
    }),
});

export const leakProbes: readonly Probe[] = [
  {
    id: "leak-search-path",
    look: "SELECT current_setting('search_path') = 'pg_catalog' AS seen",
    set: "SET search_path = pg_catalog",
    what: "search_path = pg_catalog",
  },
  {
    id: "leak-set-config-session",
    look: "SELECT current_setting('app.leak_probe', true) = 'alice' AS seen",
    set: "SELECT set_config('app.leak_probe', 'alice', false)",
    what: "set_config('app.leak_probe', 'alice', false)",
  },
  {
    // A keeps its connection: the lock is held, so B must not get it.
    id: "leak-advisory-session",
    look: "SELECT pg_try_advisory_lock(42) AS seen",
    set: "SELECT pg_advisory_lock(42)",
    what: "the advisory lock 42 as free to take (B took a lock that A holds)",
  },
  {
    id: "leak-temp-preserve-rows",
    look: "SELECT to_regclass('pg_temp.leak_probe') IS NOT NULL AS seen",
    set: "CREATE TEMP TABLE leak_probe (a int)",
    what: "the temporary table leak_probe",
  },
  {
    id: "leak-sql-prepare",
    look: "SELECT count(*) > 0 AS seen FROM pg_prepared_statements WHERE name = 'leak_probe'",
    set: "PREPARE leak_probe AS SELECT 1",
    what: "the prepared statement leak_probe",
  },
  {
    id: "leak-listen",
    look: "SELECT 'leak_probe' IN (SELECT pg_listening_channels()) AS seen",
    set: "LISTEN leak_probe",
    what: "the channel leak_probe in its listening channels",
  },
  {
    id: "leak-with-hold-cursor",
    look: "SELECT count(*) > 0 AS seen FROM pg_cursors WHERE name = 'leak_probe'",
    set: "BEGIN; DECLARE leak_probe CURSOR WITH HOLD FOR SELECT 1; COMMIT",
    what: "the held cursor leak_probe",
  },
].map(leakProbe);
