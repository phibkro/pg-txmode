# @pg-txmode/harness

A **test tool** for [pg-txmode](https://github.com/phibkro/pg-txmode): it starts a throwaway PostgreSQL and a PgBouncer in transaction mode, runs the probe matrix that backs the catalogue, and records statements. Use it in the tests of a client, an adapter or an application that must behave behind a transaction pooler. Do not use it in production.

Alpha (`0.1.0-alpha.N`, dist-tag `alpha`): `npm i -D @pg-txmode/harness@alpha`. It is versioned in lockstep with `@pg-txmode/core`, `@pg-txmode/pg`, `@pg-txmode/effect` and `@pg-txmode/lint`; install the same version of each.

## What it spawns

| Process | Started by | Found how |
| --- | --- | --- |
| `initdb`, `postgres` and `createdb` (PostgreSQL) | `startPostgres()`, `startStack()` (`initdb` and `createdb` run to completion; `postgres` keeps running) | on `PATH` |
| `pgbouncer` | `startPgBouncer()`, `startStack()` | on `PATH` |

Nothing is downloaded and nothing is installed: **you provide the binaries**. Tested with PostgreSQL 18 and PgBouncer 1.25 (the probe results in the catalogue name them). A missing binary makes the start fail with the command's own error.

Ways to provide them: `nix shell nixpkgs#postgresql_18 nixpkgs#pgbouncer`, a [devenv](https://devenv.sh) with `packages = [ pkgs.postgresql_18 pkgs.pgbouncer ]` (what this repository does), or your CI image's packages.

What it does on your machine:

- every instance gets a new temporary directory (`pg-txmode-*` under the system temp directory) and **free ports on `127.0.0.1`**; nothing listens on another interface;
- authentication is `trust`, for the user and database `app`: there is no password and no secret anywhere, which is why it must stay on loopback and in tests;
- the PgBouncer settings are the published ones of [Neon's pooler](https://neon.com/docs/connect/connection-pooling) (`pool_mode = transaction`, `max_client_conn` lowered to the open-file limit when that is lower);
- PostgreSQL runs with `fsync=off` and `synchronous_commit=off` (faster, **not durable**: a crash loses data, which a throwaway test database does not mind);
- `stop()` ends the process and removes the directory;
- **if your process dies before `stop()`** (a crash, `SIGKILL`, `SIGTERM`, `SIGINT`, a test runner that kills its worker) each server has a small watchdog, a detached `sh` that polls once a second. When the starting process is gone it kills the server and removes its directory, within about two seconds. Nothing in Node can catch `SIGKILL`, so a separate process does it; it needs a POSIX `sh` with `kill`, `sleep` and `rm`. A test (`orphans.test.ts`) kills a parent with each of the three signals and checks that no server and no directory is left. A watchdog ends by itself when the server or its parent is gone, so after a normal `stop()` it lingers for at most a second.
- **a watchdog that cannot run is a failed start, not a server without cleanup**: when `sh` is not found, or `sleep` or `rm` is not on `PATH`, the server is killed at once and `startPostgres` / `startPgBouncer` throw with the output "the cleanup watchdog (sh) could not run: ...". (Without `sleep` the watchdog's loop would spin on a core, so it checks for `sleep` and `rm` first.) A test (`watchdog.test.ts`) removes each of them from `PATH`.

## API

```ts
import { startStack, pgConnect } from "@pg-txmode/harness";

const stack = await startStack(4); // PostgreSQL + PgBouncer, 4 server connections
// stack.postgres.endpoint.url (direct), stack.pooler.endpoint.url (pooled), stack.connect()
await stack.stop();
```

`startPostgres`, `startPgBouncer`, `startStack`, `pgConnect` (a node-postgres `Session` for the probes), `probes` / `runAll` / `runProbe` (the probe matrix), `matrix` and `neonProfile` (the settings), `recording` (a statement recorder for `pg-txmode-lint --log`). The types are exported with them.

## CLI

`pg-txmode-harness up` starts PostgreSQL on port 54320 and PgBouncer on 64320 until interrupted; `pg-txmode-harness probes [output-file]` runs every probe and prints what it observed. Node 24.

## Needs

Node 24 (the tested one), the `pg` driver (a dependency), `@pg-txmode/core` at the same version. Licence: Apache-2.0.
