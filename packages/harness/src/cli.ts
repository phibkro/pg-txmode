#!/usr/bin/env bun
// `bun run stack` starts PostgreSQL and PgBouncer on fixed ports until interrupted (what `devenv up` runs);
// `bun run probes` runs every probe and prints what it observed against the catalogue.
import { writeFileSync } from "node:fs";

import { catalogue } from "@pg-txmode/core";

import { runAll } from "./matrix.ts";
import type { ProbeRun } from "./matrix.ts";
import { startPgBouncer, startPostgres } from "./stack.ts";

const postgresPort = 54_320;
const poolerPort = 64_320;

const up = async (): Promise<void> => {
  const postgres = await startPostgres({ port: postgresPort });
  const pooler = await startPgBouncer(postgres, undefined, poolerPort);
  const { promise, resolve } = Promise.withResolvers<null>();

  process.stdout.write(
    `direct  ${postgres.endpoint.url}\npooled  ${pooler.endpoint.url}  (PgBouncer, transaction mode, Neon's settings)\n`
  );
  process.once("SIGINT", () => {
    resolve(null);
  });
  process.once("SIGTERM", () => {
    resolve(null);
  });
  await promise;
  await pooler.stop();
  await postgres.stop();
};

const expectedOf = (id: string) => {
  const row = catalogue.find(
    (candidate) => "probe" in candidate && candidate.probe === id
  );

  return row === undefined
    ? undefined
    : {
        direct: row.direct.outcome,
        pooled: row.transactionPooled.outcome,
        row: row.id,
      };
};

const describeRun = (run: ProbeRun): string => {
  const expected = expectedOf(run.id);

  const agrees =
    expected?.direct === run.direct.outcome &&
    expected.pooled === run.pooled.outcome;

  return `${agrees ? "ok  " : "DIFF"} ${run.id}  direct ${run.direct.outcome}  pooled ${run.pooled.outcome}  (catalogue row ${expected?.row ?? "none"})\n     direct: ${run.direct.detail}\n     pooled: ${run.pooled.detail}`;
};

/** Prints one line per probe and returns how many disagree with the catalogue. */
const probeAndStop = async (): Promise<readonly ProbeRun[]> => {
  const postgres = await startPostgres();

  try {
    return await runAll(postgres);
  } finally {
    await postgres.stop();
  }
};

const runProbes = async (output: string | undefined): Promise<number> => {
  const runs = await probeAndStop();

  const lines = runs.map(describeRun);

  const report = `${lines.join("\n")}\n`;

  process.stdout.write(report);

  if (output !== undefined) {
    writeFileSync(output, report);
  }

  return lines.filter((line) => line.startsWith("DIFF")).length;
};

const [command, ...rest] = process.argv.slice(2);

if (command === "up") {
  await up();
} else if (command === "probes") {
  process.exitCode = (await runProbes(rest[0])) === 0 ? 0 : 1;
} else {
  process.stderr.write("usage: cli.ts up | probes [output-file]\n");
  process.exitCode = 64;
}
