import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  beginMarker,
  catalogue,
  endMarker,
  renderCatalogueTable,
  withCatalogueTable,
} from "../src/index.ts";

const readme = readFileSync(
  fileURLToPath(new URL("../../../README.md", import.meta.url)),
  "utf-8"
);

describe("the README table", () => {
  test("is the table generated from the catalogue, byte for byte", () => {
    expect(withCatalogueTable(readme)).toBe(readme);
  });

  test("control: a hand edit of one cell is detected", () => {
    const edited = readme.replace(
      "leaks (pgbouncer-probe)",
      "works (pgbouncer-probe)"
    );

    expect(edited).not.toBe(readme);
    expect(withCatalogueTable(edited)).not.toBe(edited);
  });

  test("has one row per catalogue row, each with a source link", () => {
    const lines = renderCatalogueTable().split("\n");

    expect(lines).toHaveLength(catalogue.length + 2);

    for (const [index, row] of catalogue.entries()) {
      expect(lines[index + 2]).toContain(row.sources[0]);
    }
  });

  test("needs both markers, in order", () => {
    expect(() => withCatalogueTable("no markers")).toThrow(/markers/u);
    expect(() => withCatalogueTable(`${endMarker}\n${beginMarker}`)).toThrow(
      /markers/u
    );
  });
});
