// Writes the catalogue table into README.md (`bun run docs:gen`), or fails when the README differs (`--check`).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withCatalogueTable } from "../src/render.ts";

const readmePath = fileURLToPath(
  new URL("../../../README.md", import.meta.url)
);

const current = readFileSync(readmePath, "utf-8");
const generated = withCatalogueTable(current);

if (process.argv.includes("--check")) {
  if (generated === current) {
    process.stdout.write("README.md matches the catalogue.\n");
  } else {
    process.stderr.write(
      "README.md differs from the catalogue: run `bun run docs:gen` and commit the result.\n"
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(readmePath, generated);
  process.stdout.write("README.md written from the catalogue.\n");
}
