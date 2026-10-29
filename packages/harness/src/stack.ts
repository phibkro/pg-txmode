import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";

import { neonProfile, renderPgBouncerIni } from "./profile.ts";
import type { PgBouncerSettings } from "./profile.ts";

/** Where a client connects. The user has no password: the harness servers trust loopback. */
export interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly url: string;
}

export interface Postgres {
  /** Sends the smart-shutdown signal: the server refuses new connections while existing sessions go on. */
  readonly beginSmartShutdown: () => void;
  readonly endpoint: Endpoint;
  readonly maxConnections: number;
  readonly stop: () => Promise<void>;
}

export interface Pooler {
  readonly endpoint: Endpoint;
  readonly settings: PgBouncerSettings;
  readonly stop: () => Promise<void>;
}

const database = "app";
const user = "app";
const host = "127.0.0.1";

const endpointOf = (port: number, name: string = database): Endpoint => ({
  database: name,
  host,
  port,
  url: `postgres://${user}@${host}:${port}/${name}`,
  user,
});

const isAddressInfo = (
  address: AddressInfo | string | null
): address is AddressInfo => typeof address === "object" && address !== null;

/** A free loopback port. The port is released before it is returned, so another process could take it first. */
const freePort = async (): Promise<number> => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();

  server.once("error", reject);
  server.listen(0, host, () => {
    const address = server.address();

    server.close(() => {
      if (isAddressInfo(address)) {
        resolve(address.port);
      } else {
        reject(new Error("the server has no TCP address"));
      }
    });
  });

  return await promise;
};

/** A running child with its collected output and a way to stop it and wait for the exit. */
interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
  readonly stop: () => Promise<void>;
}

const run = (command: string, args: readonly string[]): Running => {
  const chunks: string[] = [];

  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const { promise: exited, resolve } = Promise.withResolvers<number | null>();

  child.once("exit", (code) => {
    resolve(code);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });

  return {
    child,
    exited,
    output: () => chunks.join(""),
    // SIGINT is PostgreSQL's fast shutdown and PgBouncer's immediate stop; both exit promptly.
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
      }

      await exited;
    },
  };
};

const tail = (running: Running): string => running.output().slice(-4000);

/** Stops the child, waits for it to exit, and removes the directory it ran in. */
const stopAndRemove =
  (running: Running, dir: string) => async (): Promise<void> => {
    await running.stop();
    await rm(dir, { force: true, recursive: true });
  };

/** Polls until a client can connect to `url`; fails with the child's last output when it exits or never answers. */
const waitUntilAccepting = async (
  url: string,
  running: Running,
  what: string,
  attempt = 0
): Promise<void> => {
  if (running.child.exitCode !== null) {
    throw new Error(`${what} exited early:\n${tail(running)}`);
  }

  if (attempt >= 200) {
    throw new Error(`${what} did not accept connections:\n${tail(running)}`);
  }

  const client = new Client({ connectionString: url });

  const connected = await client.connect().then(
    () => true,
    () => false
  );

  if (connected) {
    await client.end();

    return;
  }

  await sleep(50);
  await waitUntilAccepting(url, running, what, attempt + 1);
};

const exec = async (
  command: string,
  args: readonly string[]
): Promise<void> => {
  const running = run(command, args);
  const code = await running.exited;

  if (code !== 0) {
    throw new Error(`${command} exited ${code}:\n${tail(running)}`);
  }
};

export interface PostgresOptions {
  readonly maxConnections?: number;
  /** A fixed port (for `devenv up`); a free one by default. */
  readonly port?: number;
}

/** A throwaway PostgreSQL on a free port, initialised in a temporary directory. `initdb` and `postgres` come from PATH. */
export const startPostgres = async (
  options: PostgresOptions = {}
): Promise<Postgres> => {
  const maxConnections = options.maxConnections ?? 100;
  const dir = await mkdtemp(path.join(tmpdir(), "pg-txmode-pg-"));
  const port = options.port ?? (await freePort());

  await exec("initdb", [
    "-D",
    `${dir}/data`,
    "-A",
    "trust",
    "-U",
    user,
    "--no-sync",
  ]);

  const running = run("postgres", [
    "-D",
    `${dir}/data`,
    "-p",
    String(port),
    "-k",
    dir,
    "-c",
    `listen_addresses=${host}`,
    "-c",
    `max_connections=${maxConnections}`,
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
  ]);

  const cleanUp = stopAndRemove(running, dir);

  try {
    await waitUntilAccepting(
      endpointOf(port, "postgres").url,
      running,
      "postgres"
    );
    await exec("createdb", [
      "-h",
      host,
      "-p",
      String(port),
      "-U",
      user,
      database,
    ]);
  } catch (error) {
    await cleanUp();
    throw error;
  }

  return {
    beginSmartShutdown: () => {
      // SIGTERM is the smart shutdown: no new connections (57P03), existing sessions stay until they end
      // (https://www.postgresql.org/docs/current/server-shutdown.html).
      running.child.kill("SIGTERM");
    },
    endpoint: endpointOf(port),
    maxConnections,
    stop: cleanUp,
  };
};

const openFileLimit = async (): Promise<number> => {
  try {
    const limits = await readFile("/proc/self/limits", "utf-8");

    const limit = /^Max open files\s+(?<limit>\d+)/mu.exec(limits)?.groups
      ?.limit;

    return limit === undefined ? 1024 : Number(limit);
  } catch {
    return 1024;
  }
};

/** A PgBouncer in front of `postgres`, on a free port unless `port` is given. `pgbouncer` comes from PATH. */
export const startPgBouncer = async (
  postgres: Postgres,
  settings: PgBouncerSettings = neonProfile(postgres.maxConnections),
  port?: number
): Promise<Pooler> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pg-txmode-pgb-"));
  const listenPort = port ?? (await freePort());

  await writeFile(`${dir}/userlist.txt`, `"${user}" ""\n`);
  await writeFile(
    `${dir}/pgbouncer.ini`,
    renderPgBouncerIni({
      database: {
        host: postgres.endpoint.host,
        name: database,
        port: postgres.endpoint.port,
        user,
      },
      dir,
      fileLimit: await openFileLimit(),
      listenPort,
      settings,
    })
  );

  const running = run("pgbouncer", [`${dir}/pgbouncer.ini`]);

  const cleanUp = stopAndRemove(running, dir);

  try {
    await waitUntilAccepting(endpointOf(listenPort).url, running, "pgbouncer");
  } catch (error) {
    await cleanUp();
    throw error;
  }

  return { endpoint: endpointOf(listenPort), settings, stop: cleanUp };
};
