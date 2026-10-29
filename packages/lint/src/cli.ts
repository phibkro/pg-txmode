#!/usr/bin/env bun
// pg-txmode-lint [--mode <mode>] [--log <file>]... [--strict] <path>...
// Lints .sql files, `sql` tagged templates in .ts/.js files and recorded statement logs for a connection mode.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  direct,
  hyperdrive,
  neonPooler,
  pgBouncer,
  sessionPooled,
  supavisor,
} from "@pg-txmode/core";
import type { ConnectionMode } from "@pg-txmode/core";

import { lintStatements } from "./analyze.ts";
import type { Finding, Statement } from "./analyze.ts";
import { extractFromFile, extractFromLog } from "./extract.ts";

const modes = new Map<string, ConnectionMode>([
  ["direct", direct],
  ["hyperdrive", hyperdrive],
  ["neon", neonPooler],
  ["pgbouncer", pgBouncer(1000)],
  ["pgbouncer-untracked", pgBouncer(0)],
  ["session", sessionPooled],
  ["supavisor", supavisor],
]);

const ignored = new Set([
  "node_modules",
  ".git",
  "dist",
  ".devenv",
  ".worktrees",
]);

/** Every file under `target`, or `target` itself when it is a file. */
const filesUnder = (target: string): readonly string[] =>
  statSync(target).isDirectory()
    ? readdirSync(target).flatMap((name) =>
        ignored.has(name) ? [] : filesUnder(path.join(target, name))
      )
    : [target];

interface Arguments {
  readonly mode: string;
  readonly logs: readonly string[];
  readonly paths: readonly string[];
  readonly strict: boolean;
}

const parseArguments = (argv: readonly string[]): Arguments => {
  const logs: string[] = [];
  const paths: string[] = [];
  let mode = "hyperdrive";
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--mode") {
      mode = argv[(index += 1)] ?? mode;
    } else if (argument === "--log") {
      logs.push(argv[(index += 1)] ?? "");
    } else if (argument === "--strict") {
      strict = true;
    } else {
      paths.push(argument);
    }
  }

  return { logs, mode, paths, strict };
};

const describeFinding = (finding: Finding): string =>
  `${finding.source}:${finding.line}:${finding.column}  ${finding.severity}  ${finding.ruleId}  ${finding.message}`;

const main = async (): Promise<number> => {
  const {
    logs,
    mode: modeName,
    paths,
    strict,
  } = parseArguments(process.argv.slice(2));

  const mode = modes.get(modeName);

  if (mode === undefined || (paths.length === 0 && logs.length === 0)) {
    process.stderr.write(
      `usage: pg-txmode-lint [--mode ${[...modes.keys()].join("|")}] [--log file]... [--strict] <path>...\n`
    );

    return 64;
  }

  const statements: Statement[] = [
    ...paths
      .flatMap(filesUnder)
      .flatMap((file) => extractFromFile(file, readFileSync(file, "utf-8"))),
    ...logs.flatMap((log) => extractFromLog(log, readFileSync(log, "utf-8"))),
  ];

  const findings = await lintStatements(statements, { mode });

  process.stdout.write(
    `${findings.map(describeFinding).join("\n")}${findings.length === 0 ? "" : "\n"}${statements.length} statement(s) checked for ${modeName}: ${findings.filter((finding) => finding.severity === "error").length} error(s), ${findings.filter((finding) => finding.severity === "warning").length} warning(s)\n`
  );

  const failing = findings.some(
    (finding) =>
      finding.severity === "error" || (strict && finding.severity === "warning")
  );

  return failing ? 1 : 0;
};

process.exitCode = await main();
