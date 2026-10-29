import {
  capabilities,
  cellOf,
  describeMode,
  featureRows,
  rowById,
} from "@pg-txmode/core";
import type { ConnectionMode, Feature, RowId } from "@pg-txmode/core";
import { SqlError, loadModule, parseSync } from "libpg-query";

import {
  field,
  isList,
  isObject,
  locationOf,
  text,
  toJson,
  walk,
} from "./ast.ts";
import type { JsonNode, JsonObject } from "./ast.ts";
import { featureRules, uncachedHits } from "./rules.ts";
import type { Hit } from "./rules.ts";

export type Severity = "error" | "warning";

/** One piece of SQL to check: a script of one or more statements, with where it came from. */
export interface Statement {
  readonly sql: string;
  /** A file path, or the name of a log. */
  readonly source: string;
  /** The line of `source` where `sql` starts (1-based). */
  readonly line: number;
  /**
   * Statements with the same sequence run one after another on one connection, so a `BEGIN` in one and a `SELECT ... FOR
   * UPDATE` in the next are one transaction. A file is one sequence; a log has one per session.
   */
  readonly sequence: string;
}

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  /** The catalogue row behind the rule, when there is one. */
  readonly row: RowId | undefined;
  readonly sources: readonly string[];
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export interface LintOptions {
  readonly mode: ConnectionMode;
}

const hitOffset = (hit: Hit): number | undefined =>
  hit.exact === true && hit.node !== undefined
    ? locationOf(hit.node)
    : undefined;

/** What to do instead, for the rules that have a known answer. */
const advice: Partial<Record<Feature, string>> = {
  listen:
    "Use a queue or the outbox pattern; a pooled connection has no session to listen on.",
  notify: "Use a queue or the outbox pattern.",
  sessionAdvisoryLock:
    "Use pg_advisory_xact_lock inside a transaction, or a row lock.",
  sessionConfig:
    "Pass true as the third argument (the setting then ends with the transaction).",
  sessionSet:
    "Use SET LOCAL inside a transaction, or set_config(name, value, true).",
  sqlPrepare: "Use the driver's protocol-level prepared statements, or none.",
  withHoldCursor: "Fetch inside one transaction, or page with keyset queries.",
};

const positionIn = (sql: string, byteOffset: number) => {
  const index = Buffer.from(sql).subarray(0, byteOffset).toString().length;
  const before = sql.slice(0, index);
  const lines = before.split("\n");

  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    lineOffset: lines.length - 1,
  };
};

interface Site {
  readonly statement: Statement;
  /** Byte offset of the finding in `statement.sql`. */
  readonly offset: number;
}

const locate = ({ statement, offset }: Site) => {
  const { column, lineOffset } = positionIn(statement.sql, offset);

  return {
    column,
    line: statement.line + lineOffset,
    source: statement.source,
  };
};

const hitMessage = (
  title: string,
  hit: Hit,
  mode: ConnectionMode,
  feature: Feature
): string => {
  const row = rowById(featureRows[feature]);
  const cell = cellOf(mode, row.id);
  const what = hit.detail === title ? title : `${title} (${hit.detail})`;
  const fix = advice[feature];

  return `${what} on a ${describeMode(mode)} connection: ${cell.note} [catalogue row ${row.id}, ${row.sources[0]}]${fix === undefined ? "" : ` ${fix}`}`;
};

const severityOf = (support: string, hit: Hit): Severity | undefined => {
  if (support === "yes") {
    return undefined;
  }

  return support === "no" && hit.undecided !== true ? "error" : "warning";
};

/** The findings of one parsed statement, in the rules' order. `inTransaction` says whether a transaction block is open. */
const findingsOf = (
  raw: JsonObject,
  site: (offset: number | undefined) => Site,
  inTransaction: boolean,
  mode: ConnectionMode
): readonly Finding[] => {
  const caps = capabilities(mode);
  const tree: JsonNode = raw;
  const visits = walk(tree);

  const fromRules = featureRules.flatMap((rule) =>
    visits.flatMap((visit) =>
      rule.hits(visit).flatMap((hit): readonly Finding[] => {
        const severity = severityOf(caps[rule.feature], hit);
        const row = rowById(featureRows[rule.feature]);

        return severity === undefined
          ? []
          : [
              {
                ...locate(site(hitOffset(hit))),
                message: hitMessage(rule.title, hit, mode, rule.feature),
                row: row.id,
                ruleId: rule.id,
                severity,
                sources: row.sources,
              },
            ];
      })
    )
  );

  const row = rowById("query-cache");
  const top = field(raw, "stmt");

  const reads =
    isObject(top) && isObject(top.SelectStmt) ? uncachedHits(top) : [];

  const uncached = caps.cachesReads
    ? reads.map((hit): Finding => ({
        ...locate(site(hitOffset(hit))),
        message: `read that calls ${hit.detail}: Hyperdrive does not cache it, so it reaches the database; the plain reads around it are cached and are not invalidated by a write [catalogue row query-cache, ${row.sources[0]}]`,
        row: row.id,
        ruleId: "uncached-read",
        severity: "warning",
        sources: row.sources,
      }))
    : [];

  const standaloneRead = isObject(top) && isObject(top.SelectStmt);

  const locked =
    inTransaction || !standaloneRead
      ? []
      : visits
          .filter((visit) => visit.name === "LockingClause")
          .map((visit): Finding => ({
            ...locate(site(locationOf(visit.node))),
            message:
              "row lock outside a transaction block: the lock is released at the end of this statement, so it protects nothing. Run it between BEGIN and COMMIT [catalogue row row-locks, https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS]",
            row: "row-locks",
            ruleId: "row-lock-outside-transaction",
            severity: "warning",
            sources: [
              "https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS",
            ],
          }));

  return [...fromRules, ...uncached, ...locked];
};

/** Whether a transaction block is open after `raw`, given whether it was before. */
const transactionAfter = (raw: JsonObject, before: boolean): boolean => {
  const stmt = field(raw, "stmt");
  const transaction = isObject(stmt) ? stmt.TransactionStmt : undefined;
  const kind = isObject(transaction) ? text(transaction.kind) : undefined;

  if (kind === "TRANS_STMT_BEGIN" || kind === "TRANS_STMT_START") {
    return true;
  }

  return kind === "TRANS_STMT_COMMIT" || kind === "TRANS_STMT_ROLLBACK"
    ? false
    : before;
};

const parseFailure = (statement: Statement, error: Error): Finding => {
  const position =
    error instanceof SqlError ? error.sqlDetails?.cursorPosition : undefined;

  const where = locate({ offset: Math.max(0, (position ?? 1) - 1), statement });

  return {
    ...where,
    message: `the PostgreSQL parser rejects this: ${error.message}`,
    row: undefined,
    ruleId: "parse-error",
    severity: "error",
    sources: [],
  };
};

interface Outcome {
  readonly findings: readonly Finding[];
  readonly inTransaction: boolean;
}

const lintOne = (
  statement: Statement,
  inTransaction: boolean,
  mode: ConnectionMode
): Outcome => {
  try {
    const parsed = toJson(parseSync(statement.sql));

    const stmts = isObject(parsed) && isList(parsed.stmts) ? parsed.stmts : [];

    const findings: Finding[] = [];
    let open = inTransaction;

    for (const raw of stmts) {
      if (isObject(raw)) {
        const start =
          typeof raw.stmt_location === "number" ? raw.stmt_location : 0;

        const site = (offset: number | undefined): Site => ({
          offset: offset ?? start,
          statement,
        });

        findings.push(...findingsOf(raw, site, open, mode));
        open = transactionAfter(raw, open);
      }
    }

    return { findings, inTransaction: open };
  } catch (error) {
    return {
      findings: error instanceof Error ? [parseFailure(statement, error)] : [],
      inTransaction,
    };
  }
};

/**
 * Checks every statement against the rules for `options.mode`. Statements of one `sequence` are checked in the order given,
 * so a transaction block opened by one is open in the next. Findings come back in that order.
 */
export const lintStatements = async (
  statements: readonly Statement[],
  options: LintOptions
): Promise<readonly Finding[]> => {
  await loadModule();

  const open = new Map<string, boolean>();
  const findings: Finding[] = [];

  for (const statement of statements) {
    const result = lintOne(
      statement,
      open.get(statement.sequence) ?? false,
      options.mode
    );

    open.set(statement.sequence, result.inTransaction);
    findings.push(...result.findings);
  }

  return findings;
};

/** The findings for one piece of SQL text, as if it were a file. */
export const lintSql = async (
  sql: string,
  options: LintOptions,
  source = "<sql>"
): Promise<readonly Finding[]> =>
  await lintStatements([{ line: 1, sequence: source, source, sql }], options);
