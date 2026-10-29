import { describeMode, rowById } from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";

/**
 * A named prepared statement was asked for on a mode that cannot keep it: the pooler does not track named statements
 * (PgBouncer with `max_prepared_statements = 0`, Supavisor), so the statement would fail with 42P05 and 26000 or run
 * another client's SQL (catalogue row `named-statements-untracked`, a pinned known issue of the harness).
 */
export class NamedStatementRefusedError extends Error {
  override readonly name = "NamedStatementRefusedError";
  readonly row = "named-statements-untracked";
  readonly sources: readonly string[];

  constructor(mode: ConnectionMode, statement: string) {
    const row = rowById("named-statements-untracked");

    super(
      `the named statement ${statement} is refused on a ${describeMode(mode)} connection: ${row.transactionPooled.note} Send it unnamed, or use a pooler that tracks named statements [catalogue row ${row.id}, ${row.sources.join(", ")}]`
    );
    this.sources = row.sources;
  }
}
