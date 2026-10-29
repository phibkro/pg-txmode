import { encodeLogEntry } from "@pg-txmode/core";

import type { Connect } from "./session.ts";

/**
 * Wraps a `Connect` so that every statement a session sends is written, in order, as one line of the statement log
 * (`StatementLogEntry`, NDJSON). Each connection is a session of its own (`s1`, `s2`, ... in the order opened). The log is
 * what `@pg-txmode/lint` reads: it holds the SQL an ORM or a query builder generated, which no source file shows.
 */
export const recording = (
  connect: Connect,
  write: (line: string) => void
): Connect => {
  let opened = 0;

  return async () => {
    const session = await connect();

    opened += 1;

    const id = `s${opened}`;

    return {
      ...session,
      query: async (text, values) => {
        write(encodeLogEntry({ session: id, sql: text }));

        return await session.query(text, values);
      },
      queryNamed: async (name, text, values) => {
        write(encodeLogEntry({ session: id, sql: text }));

        return await session.queryNamed(name, text, values);
      },
    };
  };
};
