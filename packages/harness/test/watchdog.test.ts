import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { run } from "../src/stack.ts";
import type { Running } from "../src/stack.ts";

/**
 * The watchdog that cleans up after a parent that dies must not be a silent hope: when it cannot run, the server it
 * would have guarded is killed and the output names the cause. The server here is a Node process that does nothing; the
 * `PATH` of this process is what the watchdog's `sh` is looked up in.
 */

const originalPath = process.env.PATH;

const serverArguments = ["-e", "setInterval(() => undefined, 60_000)"];

const scratch: string[] = [];
const started: Running[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;

  for (const running of started.splice(0)) {
    running.child.kill("SIGKILL");
  }

  await Promise.all(
    scratch.splice(0).map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    })
  );
});

/** A directory with the given tools of the real `PATH` linked into it, and nothing else. */
const pathWith = async (tools: readonly string[]): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pg-txmode-watchdog-"));

  scratch.push(dir);

  for (const tool of tools) {
    const real = execFileSync("sh", ["-c", `command -v ${tool}`], {
      encoding: "utf-8",
    }).trim();

    await symlink(real, path.join(dir, tool));
  }

  return dir;
};

/** Starts the stub server under `run`, in a directory of its own; `afterEach` ends it whatever the test did. */
const start = async (): Promise<Running> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pg-txmode-watchdog-dir-"));

  scratch.push(dir);

  const running = run(process.execPath, serverArguments, dir);

  started.push(running);

  return running;
};

describe("a watchdog that cannot run", () => {
  test("no sh: the server is killed and the output names sh", async () => {
    process.env.PATH = await pathWith([]);

    const running = await start();
    const code = await running.exited;

    expect(code).toBeNull();
    expect(running.output()).toContain(
      "the cleanup watchdog (sh) could not run: sh:"
    );
    expect(running.output()).toContain("ENOENT");
  }, 20_000);

  test("sh without sleep or rm: the server is killed and the output says so, with no spinning loop", async () => {
    process.env.PATH = await pathWith(["sh"]);

    const begun = Date.now();
    const running = await start();
    const code = await running.exited;

    expect(code).toBeNull();
    expect(running.output()).toContain("sleep or rm is not on PATH");
    // The guard exits at once; a loop without sleep would have kept the server alive until a kill.
    expect(Date.now() - begun).toBeLessThan(10_000);
  }, 20_000);

  test("sh with sleep and rm: the server keeps running until it is stopped (control)", async () => {
    process.env.PATH = await pathWith(["sh", "sleep", "rm"]);

    const running = await start();

    await sleep(1500);
    expect(running.child.exitCode).toBeNull();
    expect(running.child.signalCode).toBeNull();
    expect(running.output()).not.toContain("could not run");
    await running.stop();
  }, 20_000);
});
