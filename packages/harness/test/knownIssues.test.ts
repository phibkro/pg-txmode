import { describe, expect, test } from "vite-plus/test";

import { probes, runProbe } from "../src/index.ts";
import { usePostgres } from "./fixtures.ts";

/**
 * Known issues, pinned. A test here asserts that a defect still reproduces. When one starts to fail the defect has gone (a
 * new PgBouncer, a new driver): update the catalogue row it names and delete the pin, in the same change.
 */

const postgres = usePostgres();

describe("KNOWN ISSUE, catalogue row named-statements-untracked (research report M2b)", () => {
  test("named prepared statements behind PgBouncer with max_prepared_statements = 0: clients fail with 42P05, and clients that share a name run each other's SQL", async () => {
    const probe = probes.find(
      (candidate) => candidate.id === "known-issue-named-statements"
    );

    if (probe === undefined) {
      throw new Error("the probe is missing");
    }

    const run = await runProbe(postgres(), probe);

    // The control: the same clients on a direct connection are fine.
    expect(run.direct.outcome).toBe("works");
    // The defect: errors, and wrong answers for someone else's statement.
    expect(run.pooled.outcome).toBe("breaks");
    expect(run.pooled.detail).toMatch(/42P05/u);
    expect(run.pooled.detail).toMatch(/[1-9]\d* wrong answers/u);
    // Every client finished: nothing hung. The hang of @effect/sql-pg 4.0.6 (4 of 4 runs in the report) needs that client;
    // node-postgres fails loudly instead, so this pin is the failure that this harness can observe.
    expect(run.pooled.detail).toMatch(/ok, \d+ wrong answers, errors/u);
  });
});
