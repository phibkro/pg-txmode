import { catalogue, probeIds } from "@pg-txmode/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { probes, runAll, startPostgres } from "../src/index.ts";
import type { Observation, Postgres, ProbeRun } from "../src/index.ts";

/**
 * The probe suite against the catalogue. Every probe runs once against PostgreSQL (the control) and against PgBouncer in
 * transaction mode with Neon's settings; the observation must equal the catalogue's cell for that column.
 */

let postgres: Postgres;
const runs = new Map<string, ProbeRun>();

beforeAll(async () => {
  postgres = await startPostgres();

  for (const run of await runAll(postgres)) {
    runs.set(run.id, run);
  }
}, 180_000);

afterAll(async () => {
  await postgres.stop();
});

const probedRows = catalogue.flatMap((row) =>
  "probe" in row ? [{ id: row.id, probe: row.probe }] : []
);

const runOf = (id: string): ProbeRun => {
  const run = runs.get(id);

  if (run === undefined) {
    throw new Error(`probe ${id} did not run`);
  }

  return run;
};

describe("probes and catalogue name each other", () => {
  test("every probe of the harness is named by one catalogue row, and every named probe exists", () => {
    expect(probes.map((probe) => probe.id).toSorted()).toStrictEqual(
      [...probeIds].toSorted()
    );
  });
});

describe("observed against the catalogue", () => {
  test.each(probedRows)(
    "$id: PostgreSQL (control) and PgBouncer match the catalogue ($probe)",
    ({ id, probe }) => {
      const row = catalogue.find((candidate) => candidate.id === id);
      const run = runOf(probe);

      expect(run.direct.outcome, `direct: ${run.direct.detail}`).toBe(
        row?.direct.outcome
      );
      expect(run.pooled.outcome, `pooled: ${run.pooled.detail}`).toBe(
        row?.transactionPooled.outcome
      );
    }
  );
});

/** Code that assumes sessions are private (`works`) or shared (`leaks`): it must hold on one side and fail on the other. */
const assumeIsolated = (observation: Observation): void => {
  if (observation.outcome !== "works") {
    throw new Error(`session state is shared: ${observation.detail}`);
  }
};

const assumeShared = (observation: Observation): void => {
  if (observation.outcome !== "leaks") {
    throw new Error(`session state is private: ${observation.detail}`);
  }
};

const leakIds = catalogue.flatMap((row) =>
  "probe" in row && row.probe.startsWith("leak-") ? [row.probe] : []
);

describe("code that assumes the wrong connection fails, for every session-state leak (M1)", () => {
  test("the suite has the seven leaks of the report", () => {
    expect(leakIds).toHaveLength(7);
  });

  test.each(leakIds)(
    "%s: assuming private sessions holds direct and fails pooled; assuming shared sessions the reverse",
    (id) => {
      const { direct, pooled } = runOf(id);

      expect(() => {
        assumeIsolated(direct);
      }).not.toThrow();
      expect(() => {
        assumeIsolated(pooled);
      }).toThrow(/shared/u);
      expect(() => {
        assumeShared(pooled);
      }).not.toThrow();
      expect(() => {
        assumeShared(direct);
      }).toThrow(/private/u);
    }
  );
});
