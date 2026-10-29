/**
 * The recorded statement log: one JSON object per line (NDJSON), written by the harness's recorder and read by the lint.
 * `session` groups the statements of one client connection in order, so the lint can tell a transaction that is open from
 * one that is not; entries without a session belong to one anonymous session.
 */
export interface StatementLogEntry {
  readonly sql: string;
  readonly session?: string;
}

export const encodeLogEntry = (entry: StatementLogEntry): string =>
  JSON.stringify(
    entry.session === undefined
      ? { sql: entry.sql }
      : { session: entry.session, sql: entry.sql }
  );
