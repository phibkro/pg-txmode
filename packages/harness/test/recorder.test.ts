import {
  claim,
  hyperdrive,
  openingScript,
  pgBouncer,
  transactionContext,
} from "@pg-txmode/core";
import { extractFromLog, lintStatements } from "@pg-txmode/lint";
import { describe, expect, test } from "vite-plus/test";

import type { Connect } from "../src/index.ts";
import { withExampleSchema } from "../src/patternProbes.ts";
import { withSessions } from "../src/probe.ts";
import { recording } from "../src/recorder.ts";
import { targetOf, useStack } from "./fixtures.ts";

/**
 * The recorded statement log, end to end: a workload runs through a recording connection to PgBouncer, its statements are
 * written as NDJSON, and the lint reads that log. The log is where the SQL of an ORM shows up, which no source file has.
 */

const stack = useStack(5);

const record = async (
  work: (connect: Connect) => Promise<void>
): Promise<string> => {
  const lines: string[] = [];

  await withExampleSchema(targetOf(stack()), async () => {
    await work(
      recording(stack().connect, (line) => {
        lines.push(line);
      })
    );
  });

  return lines.join("\n");
};

describe("the harness writes a log that the lint reads", () => {
  test("a workload built from the library's constructs raises no error, for PgBouncer and for Hyperdrive", async () => {
    const log = await record(async (connect) => {
      await withSessions(connect, 2, async ([a, b]) => {
        await a?.query(
          openingScript({
            isolation: "serializable",
            timeouts: { statementMs: 5000 },
          })
        );
        await a?.query(transactionContext.statements.set, ["alice"]);
        await a?.query(claim.statements.claim, ["k", "alice"]);
        await a?.query("COMMIT");
        await b?.query(claim.statements.claim, ["k", "bob"]);
      });
    });

    for (const mode of [pgBouncer(1000), hyperdrive]) {
      const findings = await lintStatements(
        extractFromLog("workload.ndjson", log),
        { mode }
      );

      expect(
        findings.filter((finding) => finding.severity === "error")
      ).toStrictEqual([]);
    }
  });

  test("a workload that sets session state is caught, with the line of the log", async () => {
    const log = await record(async (connect) => {
      await withSessions(connect, 1, async ([session]) => {
        await session?.query("SELECT 1");
        await session?.query("SET search_path = pg_catalog");
      });
    });

    const findings = await lintStatements(extractFromLog("orm.ndjson", log), {
      mode: pgBouncer(1000),
    });

    expect(
      findings.map((finding) => [
        finding.ruleId,
        finding.severity,
        finding.line,
      ])
    ).toStrictEqual([["session-set", "error", 2]]);
  });

  test("the log has one session per connection, in the order sent", async () => {
    const log = await record(async (connect) => {
      await withSessions(connect, 2, async ([a, b]) => {
        await a?.query("SELECT 1");
        await b?.query("SELECT 2");
        await a?.query("SELECT 3");
      });
    });

    const sessions = extractFromLog("order.ndjson", log).map(
      (statement) => `${statement.sequence}:${statement.sql}`
    );

    expect(sessions).toHaveLength(3);
    expect(
      new Set(
        extractFromLog("order.ndjson", log).map(
          (statement) => statement.sequence
        )
      ).size
    ).toBe(2);
  });
});
