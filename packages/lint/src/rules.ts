import type { Feature } from "@pg-txmode/core";

import { field, isList, isObject, stringValue, text, walk } from "./ast.ts";
import type { JsonNode, JsonObject, Visit } from "./ast.ts";

/**
 * The rules, as data: each names the capability it guards (`feature`), and the catalogue says what a mode does with it.
 * The message, the severity and the sources of a finding come from the catalogue row of that feature; a rule only knows how
 * to recognise the SQL. A capability that is `no` for the mode is an error, one that is `unverified` is a warning, and one
 * that is `yes` raises nothing.
 */
export interface Hit {
  /** What was found, for the message: the statement kind or the function. */
  readonly detail: string;
  /** Point at the node itself (a function call) rather than at the start of its statement. */
  readonly exact?: boolean;
  /** The node the finding points at; the statement itself when absent. */
  readonly node?: JsonObject;
  /** The SQL cannot say whether it is a violation (a parameter where a boolean is needed): a warning in every mode. */
  readonly undecided?: boolean;
}

export interface FeatureRule {
  readonly id: string;
  readonly title: string;
  readonly feature: Feature;
  readonly hits: (visit: Visit) => readonly Hit[];
}

const names = (node: JsonObject): readonly string[] => {
  const list = field(node, "funcname");

  return isList(list) ? list.flatMap((item) => stringValue(item) ?? []) : [];
};

/** The name of a called function, without its schema. */
const functionName = (visit: Visit): string | undefined =>
  visit.name === "FuncCall" ? names(visit.node).at(-1) : undefined;

const calls =
  (...wanted: readonly string[]) =>
  (visit: Visit): readonly Hit[] => {
    const name = functionName(visit);

    return name !== undefined && wanted.includes(name)
      ? [{ detail: `${name}()`, exact: true, node: visit.node }]
      : [];
  };

const nodes =
  (name: string, detail: string) =>
  (visit: Visit): readonly Hit[] =>
    visit.name === name ? [{ detail, node: visit.node }] : [];

const args = (node: JsonObject): readonly JsonNode[] => {
  const list = field(node, "args");

  return isList(list) ? list : [];
};

/**
 * What a `set_config(name, value, is_local)` call says about `is_local`: `true`, `false`, or `undefined` when it is not a
 * boolean constant (a parameter). `null` when the call is not `set_config`. A boolean constant `false` is an empty `boolval`.
 */
const setConfigIsLocal = (visit: Visit): boolean | null | undefined => {
  if (functionName(visit) !== "set_config") {
    return null;
  }

  const third = args(visit.node).at(2);
  const constant = isObject(third) ? third.A_Const : undefined;
  const boolval = isObject(constant) ? constant.boolval : undefined;

  if (isObject(constant) && boolval !== undefined) {
    return isObject(boolval) && boolval.boolval === true;
  }

  return undefined;
};

/** `set_config(..., false)` and `set_config(..., $1)`: the session setting, or one the SQL cannot decide. */
const setConfigHits = (visit: Visit): readonly Hit[] => {
  const local = setConfigIsLocal(visit);

  if (local === null || local === true) {
    return [];
  }

  return local === false
    ? [{ detail: "set_config(..., false)", exact: true, node: visit.node }]
    : [
        {
          detail:
            "set_config(..., is_local) with an is_local that is not a constant",
          exact: true,
          node: visit.node,
          undecided: true,
        },
      ];
};

/** `set_config(name, value, true)`: safe behind a pooler that resets the connection, but a function call, not a `SET`. */
const setConfigLocalHits = (visit: Visit): readonly Hit[] =>
  setConfigIsLocal(visit) === true
    ? [{ detail: "set_config(..., true)", exact: true, node: visit.node }]
    : [];

/** SET and RESET without LOCAL; `SET TRANSACTION` applies to the current transaction and is not a session setting. */
const sessionSetHits = (visit: Visit): readonly Hit[] => {
  if (visit.name !== "VariableSetStmt") {
    return [];
  }

  const name = text(field(visit.node, "name"));
  const kind = text(field(visit.node, "kind"));
  const local = field(visit.node, "is_local") === true;

  if (kind === "VAR_RESET" || kind === "VAR_RESET_ALL") {
    return [{ detail: "RESET", node: visit.node }];
  }

  if (local || name === "TRANSACTION") {
    return [];
  }

  return [{ detail: `SET ${name ?? ""}`.trim(), node: visit.node }];
};

const holdOption = 0x20;

/** A cursor declaration, with or without WITH HOLD. */
const cursorHits =
  (hold: boolean) =>
  (visit: Visit): readonly Hit[] => {
    const options =
      visit.name === "DeclareCursorStmt"
        ? field(visit.node, "options")
        : undefined;

    return typeof options === "number" &&
      ((options & holdOption) !== 0) === hold
      ? [
          {
            detail: hold ? "DECLARE ... WITH HOLD" : "DECLARE CURSOR",
            node: visit.node,
          },
        ]
      : [];
  };

/** The ON COMMIT action of a temporary table, from `CREATE TEMP TABLE` or `CREATE TEMP TABLE AS`. */
const temporaryTable = (
  visit: Visit
):
  | { readonly onCommit: string | undefined; readonly node: JsonObject }
  | undefined => {
  if (visit.name === "CreateStmt") {
    const relation = field(visit.node, "relation");

    return isObject(relation) && text(relation.relpersistence) === "t"
      ? { node: visit.node, onCommit: text(field(visit.node, "oncommit")) }
      : undefined;
  }

  if (visit.name === "CreateTableAsStmt") {
    const into = field(visit.node, "into");
    const relation = isObject(into) ? into.rel : undefined;

    return isObject(into) &&
      isObject(relation) &&
      text(relation.relpersistence) === "t"
      ? { node: visit.node, onCommit: text(into.onCommit) }
      : undefined;
  }

  return undefined;
};

const preserveRowsHits = (visit: Visit): readonly Hit[] => {
  const table = temporaryTable(visit);

  return table !== undefined && table.onCommit !== "ONCOMMIT_DROP"
    ? [{ detail: "CREATE TEMP TABLE without ON COMMIT DROP", node: table.node }]
    : [];
};

const onCommitDropHits = (visit: Visit): readonly Hit[] => {
  const table = temporaryTable(visit);

  return table?.onCommit === "ONCOMMIT_DROP"
    ? [{ detail: "CREATE TEMP TABLE ... ON COMMIT DROP", node: table.node }]
    : [];
};

const isolationOption = (node: JsonNode | undefined): boolean =>
  isList(node) &&
  node.some(
    (option) =>
      isObject(option) &&
      isObject(option.DefElem) &&
      text(option.DefElem.defname) === "transaction_isolation"
  );

const isolationHits = (visit: Visit): readonly Hit[] => {
  if (visit.name === "TransactionStmt") {
    const kind = text(field(visit.node, "kind"));

    return (kind === "TRANS_STMT_BEGIN" || kind === "TRANS_STMT_START") &&
      isolationOption(field(visit.node, "options"))
      ? [{ detail: "BEGIN ISOLATION LEVEL", node: visit.node }]
      : [];
  }

  return visit.name === "VariableSetStmt" &&
    text(field(visit.node, "name")) === "TRANSACTION" &&
    isolationOption(field(visit.node, "args"))
    ? [{ detail: "SET TRANSACTION ISOLATION LEVEL", node: visit.node }]
    : [];
};

const savepointKinds = new Set([
  "TRANS_STMT_SAVEPOINT",
  "TRANS_STMT_RELEASE",
  "TRANS_STMT_ROLLBACK_TO",
]);

const savepointHits = (visit: Visit): readonly Hit[] =>
  visit.name === "TransactionStmt" &&
  savepointKinds.has(text(field(visit.node, "kind")) ?? "")
    ? [{ detail: "SAVEPOINT", node: visit.node }]
    : [];

/** The rules that guard a capability. Order is the order of the README's catalogue. */
export const featureRules: readonly FeatureRule[] = [
  {
    feature: "sessionSet",
    hits: sessionSetHits,
    id: "session-set",
    title: "SET or RESET without LOCAL",
  },
  {
    feature: "sessionConfig",
    hits: setConfigHits,
    id: "session-config",
    title: "set_config with is_local = false",
  },
  {
    feature: "transactionLocalConfig",
    hits: setConfigLocalHits,
    id: "set-config-local",
    title: "set_config with is_local = true",
  },
  {
    feature: "sqlPrepare",
    hits: (visit) =>
      ["PrepareStmt", "ExecuteStmt", "DeallocateStmt", "DiscardStmt"].flatMap(
        (name) => nodes(name, name.replace("Stmt", "").toUpperCase())(visit)
      ),
    id: "sql-prepare",
    title: "SQL-level PREPARE, EXECUTE, DEALLOCATE or DISCARD",
  },
  {
    feature: "sessionAdvisoryLock",
    hits: calls(
      "pg_advisory_lock",
      "pg_advisory_lock_shared",
      "pg_try_advisory_lock",
      "pg_try_advisory_lock_shared",
      "pg_advisory_unlock",
      "pg_advisory_unlock_shared",
      "pg_advisory_unlock_all"
    ),
    id: "session-advisory-lock",
    title: "session-level advisory lock",
  },
  {
    feature: "transactionAdvisoryLock",
    hits: calls(
      "pg_advisory_xact_lock",
      "pg_advisory_xact_lock_shared",
      "pg_try_advisory_xact_lock",
      "pg_try_advisory_xact_lock_shared"
    ),
    id: "transaction-advisory-lock",
    title: "transaction-level advisory lock",
  },
  {
    feature: "listen",
    hits: (visit) => [
      ...nodes("ListenStmt", "LISTEN")(visit),
      ...nodes("UnlistenStmt", "UNLISTEN")(visit),
    ],
    id: "listen",
    title: "LISTEN or UNLISTEN",
  },
  {
    feature: "notify",
    hits: (visit) => [
      ...nodes("NotifyStmt", "NOTIFY")(visit),
      ...calls("pg_notify")(visit),
    ],
    id: "notify",
    title: "NOTIFY",
  },
  {
    feature: "otherSessionState",
    hits: nodes("LoadStmt", "LOAD"),
    id: "load",
    title: "LOAD",
  },
  {
    feature: "withHoldCursor",
    hits: cursorHits(true),
    id: "with-hold-cursor",
    title: "cursor WITH HOLD",
  },
  {
    feature: "cursorInTransaction",
    hits: cursorHits(false),
    id: "cursor",
    title: "cursor",
  },
  {
    feature: "preserveRowsTempTable",
    hits: preserveRowsHits,
    id: "temp-table-preserve",
    title: "temporary table that keeps its rows",
  },
  {
    feature: "onCommitDropTempTable",
    hits: onCommitDropHits,
    id: "temp-table-on-commit-drop",
    title: "temporary table ON COMMIT DROP",
  },
  {
    feature: "copy",
    hits: nodes("CopyStmt", "COPY"),
    id: "copy",
    title: "COPY",
  },
  {
    feature: "isolationLevel",
    hits: isolationHits,
    id: "isolation-level",
    title: "isolation level",
  },
  {
    feature: "savepoints",
    hits: savepointHits,
    id: "savepoints",
    title: "savepoint",
  },
  {
    feature: "rowLocks",
    hits: (visit) =>
      visit.name === "LockingClause"
        ? [{ detail: "FOR UPDATE / FOR SHARE", node: visit.node }]
        : [],
    id: "row-locks",
    title: "row lock",
  },
  {
    feature: "onConflict",
    hits: (visit) =>
      visit.name === "InsertStmt" &&
      isObject(field(visit.node, "onConflictClause"))
        ? [{ detail: "ON CONFLICT", node: visit.node }]
        : [],
    id: "on-conflict",
    title: "ON CONFLICT",
  },
];

/**
 * Functions that are not `IMMUTABLE`, so Hyperdrive does not cache a read that calls them
 * (https://developers.cloudflare.com/hyperdrive/concepts/query-caching/). The common ones, not all: the volatility of a
 * function is `pg_proc.provolatile`, which a parser does not have.
 */
export const uncachedFunctions: readonly string[] = [
  "clock_timestamp",
  "currval",
  "gen_random_uuid",
  "nextval",
  "now",
  "pg_backend_pid",
  "random",
  "statement_timestamp",
  "timeofday",
  "transaction_timestamp",
  "txid_current",
  "uuid_generate_v4",
];

/** The functions of a read that make Hyperdrive skip its cache: a named function above, or any SQLValueFunction (CURRENT_TIMESTAMP and kin are STABLE). */
export const uncachedHits = (statement: JsonNode): readonly Hit[] =>
  walk(statement).flatMap((visit): readonly Hit[] => {
    const name = functionName(visit);

    if (visit.name === "SQLValueFunction") {
      return [
        { detail: "CURRENT_TIMESTAMP and kin", exact: true, node: visit.node },
      ];
    }

    return name !== undefined && uncachedFunctions.includes(name)
      ? [{ detail: `${name}()`, exact: true, node: visit.node }]
      : [];
  });
