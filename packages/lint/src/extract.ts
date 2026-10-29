import type { StatementLogEntry } from "@pg-txmode/core";
import { parseSync } from "oxc-parser";
import { z } from "zod";

import type { Statement } from "./analyze.ts";
import { field, isList, isObject, text, toJson } from "./ast.ts";
import type { JsonNode } from "./ast.ts";

/** The template tags that mark SQL. */
export const defaultTags: readonly string[] = ["sql"];

const sourcePattern = /\.[cm]?[jt]sx?$/u;

/** Every object of an ESTree under `root` whose `type` is `type`, parents before children. */
const nodesOfType = (root: JsonNode, type: string): readonly JsonNode[] => {
  if (isList(root)) {
    return root.flatMap((child) => nodesOfType(child, type));
  }

  if (!isObject(root)) {
    return [];
  }

  const own = text(field(root, "type")) === type ? [root] : [];

  return [
    ...own,
    ...Object.values(root).flatMap((child) => nodesOfType(child, type)),
  ];
};

const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

/** The SQL of one tagged template, with each `${...}` replaced by the parameter `$n` a driver would send. */
const templateText = (quasis: JsonNode | undefined): string | undefined => {
  if (!isList(quasis)) {
    return undefined;
  }

  const parts = quasis.map((quasi) => {
    const value = isObject(quasi) ? field(quasi, "value") : undefined;

    return isObject(value)
      ? (text(field(value, "cooked")) ?? text(field(value, "raw")) ?? "")
      : "";
  });

  return parts
    .map((part, index) =>
      index < parts.length - 1 ? `${part}$${index + 1}` : part
    )
    .join("");
};

/** The SQL in the tagged templates of a JavaScript or TypeScript file. Each template is its own sequence. */
export const extractFromScript = (
  path: string,
  source: string,
  tags: readonly string[] = defaultTags
): readonly Statement[] =>
  nodesOfType(
    toJson(parseSync(path, source).program),
    "TaggedTemplateExpression"
  ).flatMap((node) => {
    const tag = isObject(node) ? field(node, "tag") : undefined;
    const name = isObject(tag) ? text(field(tag, "name")) : undefined;
    const quasi = isObject(node) ? field(node, "quasi") : undefined;

    const sql = isObject(quasi)
      ? templateText(field(quasi, "quasis"))
      : undefined;

    const start = isObject(node) ? field(node, "start") : undefined;

    if (
      name === undefined ||
      !tags.includes(name) ||
      sql === undefined ||
      typeof start !== "number"
    ) {
      return [];
    }

    const line = lineAt(source, start);

    return [{ line, sequence: `${path}:${line}`, source: path, sql }];
  });

/** The statements of a file: a `.sql` file is one sequence; a script's tagged templates are one each. */
export const extractFromFile = (
  path: string,
  content: string,
  tags: readonly string[] = defaultTags
): readonly Statement[] => {
  if (path.endsWith(".sql")) {
    return [{ line: 1, sequence: path, source: path, sql: content }];
  }

  return sourcePattern.test(path) ? extractFromScript(path, content, tags) : [];
};

const LogEntry = z.object({ session: z.string().optional(), sql: z.string() });

export class StatementLogError extends Error {
  override readonly name = "StatementLogError";
}

/** Reads a log (`StatementLogEntry` per line); a line that is not an entry is an error that names its line number. */
const decodeLog = (content: string): readonly StatementLogEntry[] =>
  content
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => {
      try {
        const entry = LogEntry.parse(JSON.parse(line));

        return entry.session === undefined
          ? { sql: entry.sql }
          : { session: entry.session, sql: entry.sql };
      } catch {
        throw new StatementLogError(
          `statement log line ${number}: expected {"sql": string, "session"?: string}`
        );
      }
    });

/** The statements of a recorded log: one sequence per session, in the order recorded. */
export const extractFromLog = (
  name: string,
  content: string
): readonly Statement[] =>
  decodeLog(content).map((entry, index) => ({
    line: index + 1,
    sequence: `${name}#${entry.session ?? ""}`,
    source: name,
    sql: entry.sql,
  }));
