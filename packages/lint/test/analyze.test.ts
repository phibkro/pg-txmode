import {
  cellOf,
  direct,
  hyperdrive,
  neonPooler,
  patterns,
  pgBouncer,
  supavisor,
} from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";
import { describe, expect, test } from "vite-plus/test";

import { lintSql } from "../src/index.ts";
import type { Finding, Severity } from "../src/index.ts";

const ruleIds = (findings: readonly Finding[]): readonly string[] =>
  findings.map((finding) => finding.ruleId);

const severities = async (
  sql: string,
  mode: ConnectionMode
): Promise<Readonly<Record<string, Severity>>> =>
  Object.fromEntries(
    (await lintSql(sql, { mode })).map((finding) => [
      finding.ruleId,
      finding.severity,
    ])
  );

const pooled: readonly [string, ConnectionMode][] = [
  ["PgBouncer", pgBouncer(1000)],
  ["Hyperdrive", hyperdrive],
  ["Supavisor", supavisor],
  ["Neon", neonPooler],
];

/** The statements that the report (H5, P1) and the M1 probes show to break behind a transaction pooler. */
const sessionBreakers: readonly (readonly [string, string])[] = [
  ["SET search_path = pg_catalog", "session-set"],
  ["SET SESSION statement_timeout = 5", "session-set"],
  ["SET TIME ZONE 'UTC'", "session-set"],
  ["RESET search_path", "session-set"],
  ["RESET ALL", "session-set"],
  ["SET ROLE app", "session-set"],
  [
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "session-set",
  ],
  ["SELECT set_config('app.user', 'alice', false)", "session-config"],
  ["PREPARE p AS SELECT 1", "sql-prepare"],
  ["EXECUTE p", "sql-prepare"],
  ["DEALLOCATE p", "sql-prepare"],
  ["DISCARD ALL", "sql-prepare"],
  ["SELECT pg_advisory_lock(42)", "session-advisory-lock"],
  ["SELECT pg_try_advisory_lock(42)", "session-advisory-lock"],
  ["SELECT pg_catalog.pg_advisory_unlock_all()", "session-advisory-lock"],
  ["LISTEN channel", "listen"],
  ["UNLISTEN channel", "listen"],
  ["LOAD 'auto_explain'", "load"],
  [
    "BEGIN; DECLARE c CURSOR WITH HOLD FOR SELECT 1; COMMIT",
    "with-hold-cursor",
  ],
  ["CREATE TEMP TABLE t (a int)", "temp-table-preserve"],
  ["CREATE TEMP TABLE t (a int) ON COMMIT DELETE ROWS", "temp-table-preserve"],
  ["CREATE TEMP TABLE t AS SELECT 1", "temp-table-preserve"],
];

describe("session-state statements", () => {
  test.each(pooled)(
    "%s: every statement that breaks behind a transaction pooler is flagged, as an error unless the catalogue says the behaviour is unknown (then a warning)",
    async (_name, mode) => {
      for (const [sql, rule] of sessionBreakers) {
        const found = (await lintSql(sql, { mode })).find(
          (finding) => finding.ruleId === rule
        );

        const cell =
          found?.row === undefined ? undefined : cellOf(mode, found.row);

        expect(found, sql).toBeDefined();
        expect(found?.severity, sql).toBe(
          cell?.outcome === "unknown" ? "warning" : "error"
        );
      }
    }
  );

  test("a direct connection and a session pooler raise nothing for any of them", async () => {
    for (const [sql] of sessionBreakers) {
      expect(await lintSql(sql, { mode: direct }), sql).toStrictEqual([]);
    }
  });
});

describe("the same behaviour, written safely", () => {
  test.each(pooled)(
    "%s: SET LOCAL, set_config(..., true), SET TRANSACTION and ON COMMIT DROP raise no error",
    async (_name, mode) => {
      const findings = await lintSql(
        [
          "BEGIN",
          "SET LOCAL statement_timeout = 5000",
          "SELECT set_config('app.actor', $1, true)",
          "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
          "CREATE TEMP TABLE t (a int) ON COMMIT DROP",
          "COMMIT",
        ].join(";\n"),
        { mode }
      );

      expect(
        findings.filter((finding) => finding.severity === "error")
      ).toStrictEqual([]);
    }
  );

  test("set_config with a parameter for is_local is a warning, because the SQL cannot say", async () => {
    expect(
      await severities("SELECT set_config('a', 'b', $1)", pgBouncer(1000))
    ).toStrictEqual({
      "session-config": "warning",
    });
  });
});

describe("severity follows what is known about the mode", () => {
  test("NOTIFY is fine behind PgBouncer and an error behind Hyperdrive", async () => {
    expect(await severities("NOTIFY c", pgBouncer(1000))).toStrictEqual({});
    expect(await severities("NOTIFY c", hyperdrive)).toStrictEqual({
      notify: "error",
    });
  });

  test("a transaction-level advisory lock is fine behind PgBouncer and unverified behind Hyperdrive", async () => {
    expect(
      await severities("SELECT pg_advisory_xact_lock(1)", pgBouncer(1000))
    ).toStrictEqual({});
    expect(
      await severities("SELECT pg_advisory_xact_lock(1)", hyperdrive)
    ).toStrictEqual({
      "transaction-advisory-lock": "warning",
    });
  });

  test("set_config(..., true) is fine behind PgBouncer and unverified behind Hyperdrive", async () => {
    const sql = "BEGIN; SELECT set_config('app.actor', $1, true); COMMIT";

    expect(await severities(sql, pgBouncer(1000))).toStrictEqual({});
    expect(await severities(sql, hyperdrive)).toStrictEqual({
      "set-config-local": "warning",
    });
  });

  test("COPY and cursors are unverified everywhere that was not measured", async () => {
    expect(
      await severities("COPY t FROM STDIN", pgBouncer(1000))
    ).toStrictEqual({ copy: "warning" });
    expect(await severities("COPY t FROM STDIN", hyperdrive)).toStrictEqual({
      copy: "warning",
    });
    expect(
      await severities(
        "BEGIN; DECLARE c CURSOR FOR SELECT 1; COMMIT",
        hyperdrive
      )
    ).toStrictEqual({
      cursor: "warning",
    });
    expect(
      await severities(
        "BEGIN; DECLARE c CURSOR FOR SELECT 1; COMMIT",
        pgBouncer(1000)
      )
    ).toStrictEqual({});
  });

  test("row locks are verified behind PgBouncer and unverified behind Hyperdrive", async () => {
    const sql = "BEGIN; SELECT 1 FROM t FOR UPDATE SKIP LOCKED; COMMIT";

    expect(await severities(sql, pgBouncer(1000))).toStrictEqual({});
    expect(await severities(sql, hyperdrive)).toStrictEqual({
      "row-locks": "warning",
    });
  });
});

describe("a read that Hyperdrive does not cache", () => {
  test("warns on a function that is not IMMUTABLE, only where caching is on", async () => {
    for (const sql of [
      "SELECT now()",
      "SELECT random()",
      "SELECT current_timestamp",
      "SELECT nextval('s')",
    ]) {
      expect(
        ruleIds(await lintSql(sql, { mode: hyperdrive })),
        sql
      ).toStrictEqual(["uncached-read"]);
      expect(await lintSql(sql, { mode: pgBouncer(1000) }), sql).toStrictEqual(
        []
      );
    }
  });

  test("does not warn on a plain read, or on a write", async () => {
    expect(
      await lintSql("SELECT id FROM t WHERE id = $1", { mode: hyperdrive })
    ).toStrictEqual([]);
    expect(
      await lintSql("INSERT INTO t (at) VALUES (now())", { mode: hyperdrive })
    ).toStrictEqual([]);
  });
});

describe("a row lock outside a transaction block", () => {
  test("is a warning in every mode: it is released when the statement ends", async () => {
    for (const mode of [direct, pgBouncer(1000), hyperdrive]) {
      expect(
        ruleIds(await lintSql("SELECT 1 FROM t FOR UPDATE", { mode }))
      ).toContain("row-lock-outside-transaction");
    }
  });

  test("control: inside BEGIN ... COMMIT it is not, and neither is a lock that a write in the same statement uses", async () => {
    expect(
      ruleIds(
        await lintSql("BEGIN; SELECT 1 FROM t FOR UPDATE; COMMIT", {
          mode: direct,
        })
      )
    ).toStrictEqual([]);
    expect(
      ruleIds(
        await lintSql(
          "UPDATE t SET a = 1 WHERE id IN (SELECT id FROM t FOR UPDATE SKIP LOCKED LIMIT 1)",
          { mode: direct }
        )
      )
    ).toStrictEqual([]);
  });

  test("a COMMIT closes the block: the lock after it is outside again", async () => {
    expect(
      ruleIds(
        await lintSql("BEGIN; COMMIT; SELECT 1 FROM t FOR UPDATE", {
          mode: direct,
        })
      )
    ).toStrictEqual(["row-lock-outside-transaction"]);
  });
});

describe("findings", () => {
  test("say where: line and column of the statement in the text", async () => {
    const [finding] = await lintSql(
      "SELECT 1;\n  SET search_path = a",
      { mode: hyperdrive },
      "file.sql"
    );

    expect(finding).toMatchObject({
      column: 3,
      line: 2,
      ruleId: "session-set",
      source: "file.sql",
    });
  });

  test("quote the catalogue row, its note and its first source", async () => {
    const [finding] = await lintSql("LISTEN c", { mode: hyperdrive });

    expect(finding?.row).toBe("listen");
    expect(finding?.message).toContain("catalogue row listen");
    expect(finding?.message).toContain(
      "https://www.postgresql.org/docs/current/sql-listen.html"
    );
    expect(finding?.sources.length).toBeGreaterThan(0);
  });

  test("report SQL the PostgreSQL parser rejects", async () => {
    const findings = await lintSql("SELEC 1", { mode: hyperdrive });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "parse-error",
      severity: "error",
    });
  });
});

describe("the library's own SQL passes its own lint", () => {
  test.each(pooled)(
    "%s: every pattern, wrapped as it must be run, has no error",
    async (_name, mode) => {
      for (const pattern of patterns) {
        const statements = Object.values(pattern.statements);

        const script = pattern.needsTransaction
          ? ["BEGIN", ...statements, "COMMIT"].join(";\n")
          : statements.join(";\n");

        const findings = await lintSql(script, { mode }, pattern.id);

        expect(
          findings.filter((finding) => finding.severity === "error"),
          pattern.id
        ).toStrictEqual([]);
        expect(ruleIds(findings), pattern.id).not.toContain(
          "row-lock-outside-transaction"
        );
      }
    }
  );
});
