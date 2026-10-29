import { encodeLogEntry, hyperdrive, pgBouncer } from "@pg-txmode/core";
import { describe, expect, test } from "vite-plus/test";

import {
  extractFromFile,
  extractFromLog,
  lintStatements,
} from "../src/index.ts";

const script = [
  'import { sql } from "./db.ts";',
  "",
  "export const a = sql`SELECT * FROM t WHERE id = ${id} AND owner = ${owner}`;",
  "export const b = other`SET search_path = x`;",
  "export const c = async () => {",
  "  await db.run(sql`SET search_path = y`);",
  "};",
  "",
].join("\n");

describe("source files", () => {
  test("a .sql file is one sequence with its text as is", () => {
    expect(extractFromFile("a.sql", "SELECT 1;")).toStrictEqual([
      { line: 1, sequence: "a.sql", source: "a.sql", sql: "SELECT 1;" },
    ]);
  });

  test("only `sql` tagged templates of a script count, with ${...} as $n, and each is its own sequence", () => {
    expect(extractFromFile("repo.ts", script)).toStrictEqual([
      {
        line: 3,
        sequence: "repo.ts:3",
        source: "repo.ts",
        sql: "SELECT * FROM t WHERE id = $1 AND owner = $2",
      },
      {
        line: 6,
        sequence: "repo.ts:6",
        source: "repo.ts",
        sql: "SET search_path = y",
      },
    ]);
  });

  test("other files give nothing", () => {
    expect(extractFromFile("notes.md", "SET search_path = x")).toStrictEqual(
      []
    );
  });

  test("a finding in a template points at the line of the template", async () => {
    const findings = await lintStatements(extractFromFile("repo.ts", script), {
      mode: pgBouncer(1000),
    });

    expect(
      findings.map((finding) => [finding.ruleId, finding.line])
    ).toStrictEqual([["session-set", 6]]);
  });
});

const log = (
  entries: readonly { readonly sql: string; readonly session?: string }[]
): string => entries.map((entry) => encodeLogEntry(entry)).join("\n");

describe("a recorded statement log", () => {
  test("is linted per session: a transaction opened in one session does not cover another", async () => {
    const text = log([
      { session: "a", sql: "BEGIN" },
      { session: "b", sql: "SELECT 1 FROM t FOR UPDATE" },
      { session: "a", sql: "SELECT 1 FROM t FOR UPDATE" },
      { session: "a", sql: "COMMIT" },
    ]);

    const findings = await lintStatements(extractFromLog("run.ndjson", text), {
      mode: pgBouncer(1000),
    });

    expect(
      findings.map((finding) => [finding.ruleId, finding.line])
    ).toStrictEqual([["row-lock-outside-transaction", 2]]);
  });

  test("catches what an ORM generated and the source never shows", async () => {
    const text = log([
      { sql: "SELECT set_config('app.tenant', $1, false)" },
      {
        sql: "SELECT id FROM orders WHERE tenant = current_setting('app.tenant')",
      },
    ]);

    const findings = await lintStatements(extractFromLog("orm.ndjson", text), {
      mode: hyperdrive,
    });

    expect(findings.map((finding) => finding.ruleId)).toContain(
      "session-config"
    );
  });

  test("a line that is not a log entry is an error that names its line", () => {
    expect(() =>
      extractFromLog("bad.ndjson", '{"sql": "SELECT 1"}\n{"query": 1}\n')
    ).toThrow(/line 2/u);
  });
});
