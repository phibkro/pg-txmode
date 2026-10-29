import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { catalogue, columns, probeIds } from "../src/index.ts";
import type { Cell, Row } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const cells = (row: Row): readonly Cell[] =>
  columns.map((column) => row[column]);

/** The items of the research report that the catalogue is seeded from (REPORT.md, 2026-10-29). */
const reportItems = [
  ...Array.from({ length: 17 }, (_, n) => `H${n + 1}`),
  "M1",
  "M2a",
  "M2b",
  "M3",
  "M4",
];

describe("catalogue", () => {
  test("every row has a unique id", () => {
    const ids = catalogue.map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every report item H1 to H17 and M1 to M4 seeds at least one row", () => {
    const seeded = new Set<string>(catalogue.flatMap((row) => row.seeds));

    expect(reportItems.filter((item) => !seeded.has(item))).toStrictEqual([]);
  });

  test("every row has primary sources that are https URLs", () => {
    for (const row of catalogue) {
      expect(row.sources.length).toBeGreaterThan(0);

      for (const source of row.sources) {
        expect(source, row.id).toMatch(/^https:\/\/\S+$/u);
      }
    }
  });

  test("an unknown outcome is never verified, and every cell has a note", () => {
    for (const row of catalogue) {
      for (const cell of cells(row)) {
        expect(cell.note.length, row.id).toBeGreaterThan(0);

        if (cell.outcome === "unknown") {
          expect(cell.verifiedBy, row.id).toBe("unverified");
        }
      }
    }
  });

  test("a probe is named exactly when a cell is verified by the harness", () => {
    for (const row of catalogue) {
      const probed = cells(row).some(
        (cell) => cell.verifiedBy === "pgbouncer-probe"
      );

      expect("probe" in row, row.id).toBe(probed);
    }
  });

  test("a probe id belongs to one row", () => {
    expect(new Set(probeIds).size).toBe(probeIds.length);
  });

  test("hyperdrive-probe cells exist only with a recorded run that this repository holds", () => {
    for (const row of catalogue) {
      const through = cells(row).some(
        (cell) => cell.verifiedBy === "hyperdrive-probe"
      );

      expect("evidence" in row, row.id).toBe(through);

      if ("evidence" in row) {
        expect(existsSync(`${repoRoot}${row.evidence}`), row.evidence).toBe(
          true
        );
      }
    }
  });

  test("only the Hyperdrive column is verified by a Hyperdrive probe", () => {
    for (const row of catalogue) {
      expect(row.direct.verifiedBy, row.id).not.toBe("hyperdrive-probe");
      expect(row.transactionPooled.verifiedBy, row.id).not.toBe(
        "hyperdrive-probe"
      );
    }
  });
});
