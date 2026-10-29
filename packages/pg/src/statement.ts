import { capabilities } from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";
import type { QueryResultRow } from "pg";

import { NamedStatementRefusedError } from "./errors.ts";

/** A bind parameter. A JSON value is sent as `JSON.stringify(value)`, so no driver rule decides how it is encoded. */
export type Param = string | number | boolean | null | Date | Buffer;

/** A row as node-postgres returns it: column name to the value its type parser gives. */
export type Row = QueryResultRow;

export interface StatementOptions {
  /**
   * Prepare the statement under this name on the connection (protocol-level, as node-postgres does). Refused on a mode
   * whose pooler does not track named statements; allowed on a direct connection, Hyperdrive and PgBouncer with
   * `max_prepared_statements` above 0.
   */
  readonly name?: string;
}

/** What a pool or a pool client offers: one statement, with the values in the order of its `$n`. */
interface Queryable {
  readonly query: (config: {
    readonly name?: string;
    readonly text: string;
    readonly values: Param[];
  }) => Promise<{ readonly rows: Row[] }>;
}

/** The one door every statement of the adapter goes through: it checks the statement against the mode, then runs it. */
export type Executor = (
  target: Queryable,
  text: string,
  values: readonly Param[],
  options: StatementOptions
) => Promise<readonly Row[]>;

export const executorFor = (mode: ConnectionMode): Executor => {
  const { preparedStatements } = capabilities(mode);

  return async (target, text, values, options) => {
    if (options.name !== undefined && preparedStatements !== "named-protocol") {
      throw new NamedStatementRefusedError(mode, options.name);
    }

    const { rows } = await target.query({
      ...options,
      text,
      values: [...values],
    });

    return rows;
  };
};
