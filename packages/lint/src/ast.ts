import { z } from "zod";

/**
 * A parse tree as plain JSON. libpg-query returns a typed tree (`@pgsql/types`) whose nodes are single-key objects
 * (`{ "VariableSetStmt": { ... } }`); the rules look for a node by its name and read a few fields, so they work on this
 * untyped shape, which is what the tree is on the wire.
 */
export type JsonNode =
  | string
  | number
  | boolean
  | null
  | readonly JsonNode[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonNode;
}

export const isObject = (node: JsonNode | undefined): node is JsonObject =>
  typeof node === "object" && node !== null && !Array.isArray(node);

export const isList = (
  node: JsonNode | undefined
): node is readonly JsonNode[] => Array.isArray(node);

/** The tree of a parse result as JSON: the boundary where the typed tree becomes the shape the rules read. */
export const toJson = (tree: object): JsonNode => {
  const wire = JSON.stringify(tree);

  return z.json().parse(JSON.parse(wire));
};

export const field = (node: JsonObject, key: string): JsonNode | undefined =>
  node[key];

export const text = (node: JsonNode | undefined): string | undefined =>
  typeof node === "string" ? node : undefined;

/** A node's `sval` wrapper (`{ "String": { "sval": "x" } }` or `{ "sval": "x" }`) read as its string. */
export const stringValue = (node: JsonNode | undefined): string | undefined => {
  if (!isObject(node)) {
    return undefined;
  }

  const inner = node.String ?? node.sval;

  return isObject(inner) ? text(inner.sval) : text(inner);
};

/** Where a node starts, as a byte offset into the statement text, when the parser recorded one. */
export const locationOf = (node: JsonObject): number | undefined => {
  const { location } = node;

  return typeof location === "number" && location >= 0 ? location : undefined;
};

export interface Visit {
  /** The node type name, for example `FuncCall`. */
  readonly name: string;
  readonly node: JsonObject;
}

/**
 * Every node under `root`, parents before children. A node is an object with a single key that starts with a capital and
 * whose value is an object.
 */
export const walk = (root: JsonNode): readonly Visit[] => {
  if (isList(root)) {
    return root.flatMap(walk);
  }

  if (!isObject(root)) {
    return [];
  }

  return Object.entries(root).flatMap(([key, value]) => {
    const here =
      /^[A-Z]/u.test(key) && isObject(value)
        ? [{ name: key, node: value }]
        : [];

    return [...here, ...walk(value)];
  });
};
