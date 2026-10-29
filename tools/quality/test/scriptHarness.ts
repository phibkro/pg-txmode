import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, so a test can name a script under `.agents/skills`. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Runs `body` with a scratch directory that is removed afterwards, whether `body` returns or throws. */
export const withScratch = <T>(body: (dir: string) => T): T => {
  const dir = mkdtempSync(path.join(tmpdir(), "pg-txmode-quality-"));

  try {
    return body(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/** Writes a file (creating its directory); a mode makes a stub executable. */
export const writeFixture = (
  file: string,
  content: string,
  mode?: number
): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, mode === undefined ? {} : { mode });
};

export interface BashResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Runs a bash script with an extended environment and returns its exit status and standard output. */
export const runBash = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string
): BashResult => {
  const result = spawnSync("bash", [...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });

  return { exitCode: result.status ?? -1, stdout: result.stdout };
};
