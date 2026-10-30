import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vite-plus/test";

/**
 * A process that starts a stack and dies without calling `stop()` must not leave a server or a directory behind. The
 * parent runs in a process of its own (`orphanChild.ts`) with its own temporary directory, so the test can tell its
 * leftovers from every other test's.
 */

interface Ports {
  readonly pooler: number;
  readonly postgres: number;
}

const childPath = path.join(import.meta.dirname, "orphanChild.ts");

const accepts = async (port: number): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(port, "127.0.0.1");

  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => {
    resolve(false);
  });

  return await promise;
};

const untilTrue = async (
  check: () => Promise<boolean>,
  seconds: number
): Promise<boolean> => {
  for (let waited = 0; waited < seconds * 10; waited += 1) {
    if (await check()) {
      return true;
    }

    await sleep(100);
  }

  return await check();
};

/** The processes whose command line contains `needle` (Linux: /proc). */
const pidsNaming = async (needle: string): Promise<readonly number[]> => {
  const found: number[] = [];

  for (const entry of await readdir("/proc")) {
    if (/^\d+$/u.test(entry) && Number(entry) !== process.pid) {
      try {
        const command = await readFile(`/proc/${entry}/cmdline`, "utf-8");

        if (command.includes(needle)) {
          found.push(Number(entry));
        }
      } catch {
        // the process ended while it was read
      }
    }
  }

  return found;
};

/** Starts the parent, waits until its servers accept connections, kills it with `signal`, and reports what is left. */
const killParent = async (
  signal: NodeJS.Signals
): Promise<{
  readonly directories: readonly string[];
  readonly serversWereUp: boolean;
  readonly serversGone: boolean;
}> => {
  const scratch = await mkdtemp(path.join(tmpdir(), "pg-txmode-orphans-"));

  const parent = spawn(process.execPath, [childPath], {
    env: { ...process.env, TMPDIR: scratch },
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const { promise: line, resolve } = Promise.withResolvers<string>();

    parent.stdout.once("data", (chunk: Buffer) => {
      resolve(chunk.toString());
    });

    // orphanChild.ts prints {"pooler":<port>,"postgres":<port>} as its first line.
    const found = /"pooler":(?<pooler>\d+),"postgres":(?<postgres>\d+)/u.exec(
      await line
    )?.groups;

    if (found?.pooler === undefined || found.postgres === undefined) {
      throw new Error("the parent did not report its ports");
    }

    const ports: Ports = {
      pooler: Number(found.pooler),
      postgres: Number(found.postgres),
    };

    const serversWereUp =
      (await accepts(ports.postgres)) && (await accepts(ports.pooler));

    parent.kill(signal);

    const serversGone = await untilTrue(
      async () =>
        !(await accepts(ports.postgres)) && !(await accepts(ports.pooler)),
      20
    );

    await untilTrue(async () => (await readdir(scratch)).length === 0, 20);

    return { directories: await readdir(scratch), serversGone, serversWereUp };
  } finally {
    // A failing run (the watchdog broken) leaves servers whose command line names this scratch directory: end exactly
    // those, by pid, before the directory goes.
    // The parent's command line does not name the directory, so it is ended itself (a run that threw before the kill).
    parent.kill("SIGKILL");

    for (const pid of await pidsNaming(scratch)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }

    await rm(scratch, { force: true, recursive: true });
  }
};

describe("a parent that dies before stop()", () => {
  for (const signal of ["SIGKILL", "SIGTERM", "SIGINT"] as const) {
    test(`${signal} leaves no server and no directory behind`, async () => {
      const left = await killParent(signal);

      expect(left.serversWereUp).toBe(true);
      expect(left.serversGone).toBe(true);
      expect(left.directories).toStrictEqual([]);
    }, 90_000);
  }
});
