import { describe, expect, test } from "vite-plus/test";

import { matrix, probes, runProbe } from "../src/index.ts";
import type { Probe } from "../src/index.ts";
import { usePostgres } from "./fixtures.ts";

/**
 * The matrix of the report (gap 7): `max_prepared_statements` in {0, 1000} and `default_pool_size` in {1, 5}, with the
 * profile's other settings (Neon's) fixed. The settings decide two things and nothing else: whether named prepared
 * statements work, and (with a pool of 1) whether two clients are certain to share a server connection.
 */

const postgres = usePostgres();

const probeNamed = (id: string): Probe => {
  const probe = probes.find((candidate) => candidate.id === id);

  if (probe === undefined) {
    throw new Error(`no probe ${id}`);
  }

  return probe;
};

describe.each(matrix)("PgBouncer $label", ({ label, settings }) => {
  const withSettings = (id: string): Probe => ({
    ...probeNamed(id),
    maxPreparedStatements: settings.maxPreparedStatements,
    poolSize: settings.defaultPoolSize,
  });

  test(`${label}: named prepared statements work exactly when PgBouncer tracks them`, async () => {
    const tracked = settings.maxPreparedStatements > 0;

    const run = await runProbe(
      postgres(),
      withSettings("known-issue-named-statements")
    );

    expect(run.direct.outcome).toBe("works");
    expect(run.pooled.outcome, run.pooled.detail).toBe(
      tracked ? "works" : "breaks"
    );
  });

  test(`${label}: unnamed statements work either way`, async () => {
    const run = await runProbe(postgres(), withSettings("unnamed-statements"));

    expect(run.pooled.outcome, run.pooled.detail).toBe("works");
  });

  test(`${label}: a direct connection never shares session state`, async () => {
    const run = await runProbe(postgres(), withSettings("leak-search-path"));

    expect(run.direct.outcome).toBe("works");
  });

  test.runIf(settings.defaultPoolSize === 1)(
    `${label}: with one server connection, clients share session state`,
    async () => {
      const run = await runProbe(postgres(), withSettings("leak-search-path"));

      expect(run.pooled.outcome, run.pooled.detail).toBe("leaks");
    }
  );
});
