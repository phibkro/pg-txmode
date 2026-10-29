/**
 * What a connection does with a PostgreSQL behaviour, as the client sees it.
 *
 * - `works`: behaves as PostgreSQL documents; safe to rely on.
 * - `scoped`: works, but only for the transaction or the statement (the state does not persist).
 * - `leaks`: succeeds without an error, and its effect is visible to other clients. Nothing reports the mistake.
 * - `unsupported`: documented as not supported (an error, or undefined behaviour).
 * - `breaks`: observed to fail or hang.
 * - `degrades`: works, and costs capacity another client needs.
 * - `differs`: behaves differently from what the same code does elsewhere.
 * - `unknown`: neither documented nor measured. Treated as not safe.
 */
export type Outcome =
  | "works"
  | "scoped"
  | "leaks"
  | "unsupported"
  | "breaks"
  | "degrades"
  | "differs"
  | "unknown";

/**
 * How a cell is known.
 *
 * - `docs`: a primary source states it (the row's `sources`).
 * - `pgbouncer-probe`: a probe of this repository's harness observed it (the row's `probe`), run against PgBouncer in
 *   transaction mode and, as its control, against a direct PostgreSQL connection.
 * - `hyperdrive-probe`: a probe observed it through Cloudflare Hyperdrive; the row's `evidence` names the recorded run.
 * - `unverified`: read or measured somewhere this repository cannot reproduce, or not at all (the cell's `note` says
 *   where it came from).
 */
export type VerifiedBy =
  | "docs"
  | "pgbouncer-probe"
  | "hyperdrive-probe"
  | "unverified";

export interface Cell {
  readonly outcome: Outcome;
  readonly verifiedBy: VerifiedBy;
  /** What the outcome means here, in one sentence. */
  readonly note: string;
}

/** The three columns of the catalogue. */
export type Column = "direct" | "transactionPooled" | "hyperdrive";

export const columns: readonly Column[] = [
  "direct",
  "transactionPooled",
  "hyperdrive",
];

export interface Row {
  /** Stable kebab-case identifier; lint messages, capabilities and probes refer to it. */
  readonly id: string;
  readonly behaviour: string;
  readonly direct: Cell;
  readonly transactionPooled: Cell;
  readonly hyperdrive: Cell;
  /** Primary sources (URLs). At least one. */
  readonly sources: readonly [string, ...string[]];
  /** The harness probe that verifies a `pgbouncer-probe` cell. Required exactly when such a cell exists. */
  readonly probe?: string;
  /** The recorded Hyperdrive run (a path in this repository). Required exactly when a `hyperdrive-probe` cell exists. */
  readonly evidence?: string;
  /** The items of the research report (REPORT.md of 2026-10-29) that this row seeds, such as `H2` or `M1`. */
  readonly seeds: readonly string[];
}
