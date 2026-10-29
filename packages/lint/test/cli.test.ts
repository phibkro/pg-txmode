import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

/**
 * The command line is the gate people run: its exit code and its output are what must not pass on nothing. Each test
 * runs the real CLI (`bun src/cli.ts`) on files the test writes into a temporary directory.
 */

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pg-txmode-lint-cli-"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

const run = (name: string, content: string, ...flags: string[]) => {
  const file = path.join(dir, name);

  writeFileSync(file, content);

  const result = spawnSync(
    "bun",
    [cli, "--mode", "hyperdrive", ...flags, file],
    {
      encoding: "utf-8",
    }
  );

  return { exit: result.status, file, out: result.stdout };
};

describe("the lint command line", () => {
  test("a script that does not parse is a parse-error finding and exit 1, never 0 statements and success", () => {
    const { exit, file, out } = run(
      "broken.ts",
      "const a = sql`SET search_path = x`;\nconst b = ;\n"
    );

    expect(out).toContain(`${file}:2:11  error  parse-error`);
    expect(out).toContain("1 error(s)");
    expect(exit).toBe(1);
  });

  test("a file with a violation exits 1 and one without exits 0", () => {
    expect(run("bad.sql", "SET search_path = x;\n").exit).toBe(1);
    expect(run("good.sql", "SELECT 1;\n").exit).toBe(0);
  });

  test("a warning fails only with --strict", () => {
    const warning = "SELECT set_config('app.tenant', 'a', false);\n";

    expect(run("warning.sql", warning).exit).toBe(0);
    expect(run("warning-strict.sql", warning, "--strict").exit).toBe(1);
  });
});
