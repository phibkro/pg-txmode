import { rowById, supavisorCells } from "./catalogue.ts";
import type { RowId } from "./catalogue.ts";
import type { Cell, Column, Outcome } from "./catalogueTypes.ts";

/**
 * The connection mode: what stands between the client and PostgreSQL. A client is built for one mode and receives only
 * what that mode can do, so a feature that the pooler cannot honour is not available to call (see `SessionApi`) or is
 * refused with the catalogue's reason (`requireFeature`).
 *
 * The capability record is computed from the catalogue, never written twice: every `Support` is the outcome of one
 * catalogue row in the mode's column. `yes` means `works`, `unverified` means `unknown` (neither documented nor
 * measured, and treated as not safe), `no` is every other outcome.
 */

export interface DirectMode {
  readonly kind: "Direct";
}

/** A pooler that keeps one server connection per client session (PgBouncer `pool_mode = session`). */
export interface SessionPooledMode {
  readonly kind: "SessionPooled";
}

export type TransactionPooledMode =
  | { readonly kind: "TransactionPooled"; readonly pooler: "hyperdrive" }
  | { readonly kind: "TransactionPooled"; readonly pooler: "supavisor" }
  /** Neon's pooler is PgBouncer with `max_prepared_statements = 1000` (https://neon.com/docs/connect/connection-pooling). */
  | { readonly kind: "TransactionPooled"; readonly pooler: "neon" }
  | {
      readonly kind: "TransactionPooled";
      readonly pooler: "pgbouncer";
      /** PgBouncer's `max_prepared_statements`; 0 means it does not track named statements. */
      readonly maxPreparedStatements: number;
    };

export type ConnectionMode =
  | DirectMode
  | SessionPooledMode
  | TransactionPooledMode;

export const direct: DirectMode = { kind: "Direct" };

export const sessionPooled: SessionPooledMode = { kind: "SessionPooled" };

export const hyperdrive: TransactionPooledMode = {
  kind: "TransactionPooled",
  pooler: "hyperdrive",
};

export const supavisor: TransactionPooledMode = {
  kind: "TransactionPooled",
  pooler: "supavisor",
};

export const neonPooler: TransactionPooledMode = {
  kind: "TransactionPooled",
  pooler: "neon",
};

export const pgBouncer = (
  maxPreparedStatements: number
): TransactionPooledMode => ({
  kind: "TransactionPooled",
  maxPreparedStatements,
  pooler: "pgbouncer",
});

/**
 * Applies `Api` only to a mode that keeps the session. For a `TransactionPooledMode` it is `never`, so an adapter that
 * types its session-only methods with it offers none on a pooled client.
 */
export type SessionApi<Mode extends ConnectionMode, Api> = Mode extends {
  readonly kind: "TransactionPooled";
}
  ? never
  : Api;

export type Support = "yes" | "no" | "unverified";

/** The feature names and the catalogue row that decides each. */
export const featureRows = {
  cancelRequest: "cancel-request",
  copy: "copy",
  cursorInTransaction: "cursor-in-transaction",
  isolationLevel: "isolation-level",
  listen: "listen",
  notify: "notify",
  onCommitDropTempTable: "temp-table-on-commit-drop",
  onConflict: "on-conflict",
  otherSessionState: "other-session-state",
  pipelining: "pipelining",
  preserveRowsTempTable: "temp-table-preserve",
  requestAbortRollsBack: "request-abort",
  rowLocks: "row-locks",
  savepoints: "savepoints",
  sessionAdvisoryLock: "advisory-session",
  sessionConfig: "set-config-session",
  sessionSet: "set-session",
  sqlPrepare: "sql-prepare",
  transactionAdvisoryLock: "advisory-xact",
  transactionLocalSettings: "set-local",
  withHoldCursor: "with-hold-cursor",
} as const satisfies Record<string, RowId>;

export type Feature = keyof typeof featureRows;

/** The features that live in the session, so a pooler that shares sessions cannot honour them. */
export const sessionOnlyFeatures = [
  "listen",
  "notify",
  "otherSessionState",
  "preserveRowsTempTable",
  "sessionAdvisoryLock",
  "sessionConfig",
  "sessionSet",
  "sqlPrepare",
  "withHoldCursor",
] as const satisfies readonly Feature[];

export type SessionOnlyFeature = (typeof sessionOnlyFeatures)[number];

export type PreparedStatements =
  /** Named statements at the protocol level work, as on a direct connection. */
  | "named-protocol"
  /** Only unnamed statements (a driver's `prepare: false`) are safe. */
  | "unnamed-only";

export type Capabilities = Readonly<Record<Feature, Support>> & {
  readonly preparedStatements: PreparedStatements;
  /** Reads are cached by the proxy and never invalidated by a write (Hyperdrive's default). */
  readonly cachesReads: boolean;
};

const supportOf = (outcome: Outcome): Support => {
  if (outcome === "works") {
    return "yes";
  }

  return outcome === "unknown" ? "unverified" : "no";
};

export const columnOf = (mode: ConnectionMode): Column => {
  if (mode.kind !== "TransactionPooled") {
    // A session pooler keeps one server connection per session: it behaves as a direct connection
    // (https://www.pgbouncer.org/config.html#pool_mode, "session").
    return "direct";
  }

  return mode.pooler === "hyperdrive" ? "hyperdrive" : "transactionPooled";
};

/**
 * The cell of `id` in the mode's column. Supavisor is the transaction-pooled column with the cells of `supavisorCells`
 * laid over it, so its differences from PgBouncer are catalogue data, quoted by the errors that refuse them.
 */
export const cellOf = (mode: ConnectionMode, id: RowId): Cell =>
  mode.kind === "TransactionPooled" && mode.pooler === "supavisor"
    ? (supavisorCells[id] ?? rowById(id).transactionPooled)
    : rowById(id)[columnOf(mode)];

const preparedStatementsOf = (mode: ConnectionMode): PreparedStatements => {
  if (mode.kind !== "TransactionPooled") {
    return "named-protocol";
  }

  if (mode.pooler === "supavisor") {
    return "unnamed-only";
  }

  if (mode.pooler === "pgbouncer" && mode.maxPreparedStatements === 0) {
    return "unnamed-only";
  }

  return "named-protocol";
};

export const capabilities = (mode: ConnectionMode): Capabilities => {
  const support = (feature: Feature): Support =>
    supportOf(cellOf(mode, featureRows[feature]).outcome);

  return {
    cachesReads: cellOf(mode, "query-cache").outcome === "differs",
    cancelRequest: support("cancelRequest"),
    copy: support("copy"),
    cursorInTransaction: support("cursorInTransaction"),
    isolationLevel: support("isolationLevel"),
    listen: support("listen"),
    notify: support("notify"),
    onCommitDropTempTable: support("onCommitDropTempTable"),
    onConflict: support("onConflict"),
    otherSessionState: support("otherSessionState"),
    pipelining: support("pipelining"),
    preparedStatements: preparedStatementsOf(mode),
    preserveRowsTempTable: support("preserveRowsTempTable"),
    requestAbortRollsBack: support("requestAbortRollsBack"),
    rowLocks: support("rowLocks"),
    savepoints: support("savepoints"),
    sessionAdvisoryLock: support("sessionAdvisoryLock"),
    sessionConfig: support("sessionConfig"),
    sessionSet: support("sessionSet"),
    sqlPrepare: support("sqlPrepare"),
    transactionAdvisoryLock: support("transactionAdvisoryLock"),
    transactionLocalSettings: support("transactionLocalSettings"),
    withHoldCursor: support("withHoldCursor"),
  };
};

export const describeMode = (mode: ConnectionMode): string =>
  mode.kind === "TransactionPooled"
    ? `transaction-pooled (${mode.pooler})`
    : mode.kind;

export class UnsupportedFeatureError extends Error {
  override readonly name = "UnsupportedFeatureError";
  readonly feature: Feature;
  readonly row: RowId;
  readonly support: Support;
  readonly sources: readonly string[];

  constructor(mode: ConnectionMode, feature: Feature, support: Support) {
    const row = rowById(featureRows[feature]);
    const cell = cellOf(mode, row.id);

    super(
      `${feature} is ${support === "no" ? "not available" : "unverified"} on a ${describeMode(mode)} connection: ${cell.note} (catalogue row ${row.id}; ${row.sources.join(", ")})`
    );
    this.feature = feature;
    this.row = row.id;
    this.support = support;
    this.sources = row.sources;
  }
}

export interface FeatureOptions {
  /** Accept a feature that is neither documented nor measured for the mode. Off by default. */
  readonly allowUnverified?: boolean;
}

/** Throws `UnsupportedFeatureError`, quoting the catalogue row and its sources, unless the mode supports the feature. */
export const requireFeature = (
  mode: ConnectionMode,
  feature: Feature,
  options: FeatureOptions = {}
): void => {
  const support = capabilities(mode)[feature];

  if (
    support === "yes" ||
    (support === "unverified" && options.allowUnverified === true)
  ) {
    return;
  }

  throw new UnsupportedFeatureError(mode, feature, support);
};
