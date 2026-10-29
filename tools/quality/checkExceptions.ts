// Provenance: ported from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (tools/quality/checkEffectExceptions.ts),
// which adapted it from phibkro/vektorprogrammet-reimagined @ 797e9e41d96194b9479ff224ac1c40bbc0545888. Deviation: plain
// TypeScript, no Effect. The checks live in exceptions.ts. See PROVENANCE.md.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { checkExceptions } from "./exceptions.ts";

/** The registry sits next to this checker; the source paths inside it stay repo-relative. */
const registryPath = new URL("exceptions.json", import.meta.url).pathname;

const listing = execFileSync(
  "git",
  ["ls-files", "-c", "-o", "--exclude-standard"],
  { encoding: "utf-8" }
);

const { exceptionCount, findings } = checkExceptions({
  paths: listing.split(/\r?\n/u).filter((line) => line !== ""),
  registryPath,
  root: path.resolve("."),
});

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Exception registry clean (${exceptionCount} suppression exceptions).\n`
  );
}
