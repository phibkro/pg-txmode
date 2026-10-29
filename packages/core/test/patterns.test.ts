import { describe, expect, test } from "vite-plus/test";

import { catalogue } from "../src/catalogue.ts";
import { patterns } from "../src/patterns.ts";

describe("the patterns name the catalogue rows they depend on", () => {
  test("every row of every pattern exists", () => {
    const ids = new Set<string>(catalogue.map((row) => row.id));

    for (const pattern of patterns) {
      for (const row of pattern.rows) {
        expect(ids.has(row), `${pattern.id}: ${row}`).toBe(true);
      }
    }
  });
});
