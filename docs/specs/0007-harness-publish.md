# 0007 Publish `@pg-txmode/harness` as a documented test tool

Status: **spec** (frozen when its PR opens). Date: 2026-10-30. Decided by: the operator, 2026-10-30 (relayed by the lead): `pg-outbox` needs the harness (`startPostgres`, `startStack`, `pgConnect`, the session, stack, duo and profile) in its conformance suite and tests, so it is published once here and not copied.
Process: [spec 0000](0000-development-lifecycle.md). Based on `main` (specs 0000 to 0006 merged; `@pg-txmode/{core,pg,effect,lint}@0.1.0-alpha.0` published). It reuses the release path of [spec 0006](0006-release.md) and changes one of its decisions (which packages publish).
Verify skill: `verify-pg-txmode` (updated: the release row names the harness).

## Problem

`@pg-txmode/harness` is `private`. A project that wants to test a client, an adapter or an application behind a real transaction pooler (pg-outbox first) has to copy its files or depend on this repository by path.

## Goal

`npm i -D @pg-txmode/harness@alpha` gives a test tool with a README that says what it spawns, from where, and what it does to the machine. This PR changes manifests, one README and the release gates, and publishes nothing; a second PR (the version commit) gives all five packages `0.1.0-alpha.1`; the operator then dispatches `mode=publish`.

## Journey

```sh
git checkout feat/0007-harness-publish
devenv shell -- bun run release:stage          # five dist directories, harness included
cd /tmp && npm publish <repo>/packages/harness/dist --dry-run --tag alpha --access public
# in a scratch project, with initdb, postgres and pgbouncer on PATH (devenv shell):
npm i <core tarball> <harness tarball> && node -e 'import("@pg-txmode/harness").then(async ({startStack}) => { const s = await startStack(3); console.log(s.pooler.endpoint.url); await s.stop(); })'
```

Evidence: [`docs/evidence/harness-publish/README.md`](../evidence/harness-publish/README.md).

## Decisions

### The harness joins the published set

| Item | Decision | Why |
| --- | --- | --- |
| `private` | removed; `description`, `license`, `publishConfig` (`access: public`, `directory: dist`) and a `prepublishOnly` that refuses a source-directory publish, as the other four | the rules of spec 0006 apply unchanged: the published set is "no `private`" |
| `files` | none: `dist` is the package root and `release:stage` fails on any file that is not built output | spec 0006, stage step 4 |
| `bin` | `pg-txmode-harness` ships built (`cli.mjs`, node shebang); it is what `devenv up` runs here | as `pg-txmode-lint` |
| dependencies | `@pg-txmode/core` (exact, lockstep), `pg` (caret), **`@types/pg`** (caret) | the declaration file contains `declare module "pg"` (the harness adds `processID` and `secretKey` to `Client`, which node-postgres does not type): a consumer without `@types/pg` fails `tsc` with TS2665 ("Module 'pg' resolves to an untyped module, which cannot be augmented"). Found by the consumer check; `importFindings` now reads `declare module "x"` like an import, so this class fails the stage |
| `@pg-txmode/lint` | stays a development dependency | only the tests use it |
| peers / engines | none; Node 24 is the version it was run on, said in the README, not enforced (spec 0006 Revisions 4: nothing measured a floor) | |
| secrets | none: authentication is `trust` on `127.0.0.1`, user and database `app`; the README says so | the repository is public |
| README | `packages/harness/README.md` ships (stage copies a package README when there is one; the others keep the generated one) | what it spawns (`initdb`, `postgres`, `createdb`, `pgbouncer`, from `PATH`), non-durable PostgreSQL settings, what happens when the starting process dies, how to provide them (`nix shell`, devenv, CI image), temporary directories, free loopback ports, `stop()` |
| Release rules | the test "the harness stays private" becomes "all five are published, nothing is private"; the two "workspace:* to a private package" controls use a synthetic private name | the controls still fail what they failed before |

### Lockstep: all five at `0.1.0-alpha.1`

The harness joins the Changesets `fixed` group, so the group is again the published set (`release.test.ts`). Rehearsed (evidence section 3): a minor changeset on the harness alone makes `changeset version` give **all five** `0.1.0-alpha.1`; core, pg, effect and lint get "No changes in this release" in their CHANGELOG, and their shipped manifests change only in `version` and in the exact `@pg-txmode/core` pin.

Alternative: leave the harness out of the group at `0.1.0-alpha.0` and republish nothing. Rejected: the gated invariant (group = published set) and the exact internal pins are what keep a consumer from mixing versions; two version lines would be the first divergence, forever. The cost is four republished packages whose code is the same.

What the lockstep publish does to dist-tags, with the `Publish` step of spec 0006 (`npm publish --tag alpha` for each, core first, skipping a version the registry has):

- `alpha` moves to `0.1.0-alpha.1` on all five;
- `latest` of the four stays on `0.1.0-alpha.0` (observed on the local registry in spec 0006: later publishes with an explicit `--tag` do not move it; on npm: only the first-publish value is observed, Revisions 4); `latest` of the harness is set by npm on its first publish, which gives `0.1.0-alpha.1` by the rule observed for the four (read it afterwards);
- an install by `@alpha` gets a consistent set; an untagged install of core gets `0.1.0-alpha.0` and of the harness `0.1.0-alpha.1`, which are not a consistent pair: the README already says `latest` is unmanaged and `@alpha` is the one to use.

## Gates and falsifiers

| # | Falsifier | Gate | Control |
| --- | --- | --- | --- |
| F-h1 | The published set is the five packages, none private; the fixed group equals it | `release.test.ts` | (unchanged rule) the harness removed from the group fails it |
| F-h2 | A declaration file's `declare module "pkg"` needs the types of `pkg` to ship | `release:stage` (`importFindings`), unit test | `@types/pg` moved to `devDependencies` of the harness on the real tree: `@pg-txmode/harness: index.d.mts imports pg, and its types @types/pg are a devDependency, which does not ship`, exit 1 |
| F-h3 | The tarball installs, imports, starts a stack and type-checks in a project that is not this repository | evidence section 2 (needs the PostgreSQL and PgBouncer binaries; not a gate) | before the `@types/pg` fix: `tsc` exit 1, TS2665 |
| F-h4 | The stage copies a package README | `release:stage` listing (`README.md` of 4.2 kB in the harness tarball (2.8 kB at the first commit of #15), the generated 250 B in the others) | n/a |
| F-h5 | A published package may not depend on a private one | `release.test.ts` | a synthetic private package (fixture) |
| F-h6 | A parent that dies before `stop()` leaves no server and no directory | `orphans.test.ts` (parent killed with `SIGKILL`, `SIGTERM`, `SIGINT`; its own `TMPDIR`) | the watchdog disabled: all three fail |
| F-h7 | The README exists and names every binary spawned, the non-durable settings and the cleanup | `release.test.ts` | the generated README names none (fixture) |

## Constraints and values

- No Effect; no secret; no publish by an agent; the token path and the `Release` workflow are untouched (they already publish every `packages/*/dist`).
- The harness is a test tool and says so: it starts processes and writes temporary directories. Nothing about it runs at import time.
- Not claimed: PostgreSQL or PgBouncer versions other than 18 and 1.25, Windows, a Node version other than 24.21.0, a Bun consumer.

## Operator steps

1. Merge this PR (nothing is published).
2. The version PR: a changeset for the harness, `bun run release:version` (all five at `0.1.0-alpha.1`).
3. The operator dispatches `mode=publish`; afterwards read `npm view @pg-txmode/<name> dist-tags` for the five. If the run fails part-way (for example the new name `@pg-txmode/harness` is refused), `@alpha` is a mixed set until a re-run completes: re-run, do not install in between.

## Revisions

- **2026-10-30, plan written** with the build. It supersedes the line of spec 0006 that keeps the harness private (a dated entry is added there too).
- **2026-10-30, after review round 1 of PR #15 (recorded by `RevPgTx3` at `5996488`).**
  1. **A parent that dies leaves no server behind (medium).** `run()` had no exit or signal hook: a Node process that called `startStack` and then got `SIGKILL`, `SIGTERM` or `SIGINT` left `postgres`, `pgbouncer` and both `pg-txmode-*` directories behind in 3 of 3 runs on the installed tarball (the reviewer found 26 stale directories and 19 orphan servers on the same machine). Fix: each server gets a **watchdog**, a detached `sh` (`kill -0` poll once a second) that, when the starting process is gone and the server still runs, kills it and removes its directory. A watchdog and not a Node signal handler because nothing in Node can catch `SIGKILL`; one mechanism covers all three signals and a crash, and it does not install handlers in the consumer's process (a signal handler would change whether `SIGINT` terminates it). Limits, in the README: needs a POSIX `sh`; cleanup within about two seconds, not instantly; a `stop()` leaves a watchdog for at most a second. **Falsifier F-h6** (`orphans.test.ts`): a parent process starts a stack with its own `TMPDIR`, is killed with `SIGKILL`, `SIGTERM` and `SIGINT`, and the test checks that neither port accepts connections and the `TMPDIR` is empty. Control: with the watchdog line disabled all three fail (`3 failed`, 41 s each: the servers stay up); the orphans that control created were ended by pid.
  2. **The README names `createdb`, `fsync=off` and `synchronous_commit=off`**, and the cleanup above. **F-h7** (`release.test.ts`): the README must exist and mention `initdb`, `postgres`, `createdb`, `pgbouncer`, `fsync=off`, `SIGKILL` and `watchdog`; the same check on what stage generates for a package without a README names none of them.
  3. **`@alpha` is split if the publish stops at the new name.** The `Publish` step is alphabetical (core, effect, harness, lint, pg) and stops at the first failure: a registry that refuses the new name leaves core and effect at `0.1.0-alpha.1`, lint and pg at `0.1.0-alpha.0`, harness absent. The re-run publishes the rest. Not changed in code (the order is the glob's); an `@alpha` install is a consistent set only after a **complete** run, and the operator steps now say so.
  4. **npm's first-publish `latest` is observed now.** On the real registry (read only, 2026-10-30, `npm view @pg-txmode/<name> dist-tags`): core, pg, effect and lint have `{latest: 0.1.0-alpha.0, alpha: 0.1.0-alpha.0}`: npm sets `latest` on a first publish with `--tag alpha`. The harness is E404 until its first publish, so its `latest` will be `0.1.0-alpha.1` by the same rule (inferred, not observed). That a later publish with an explicit `--tag alpha` leaves `latest` alone is still observed only on the local registry; read the dist-tags of all five after the run.
  5. **The changeset text no longer refers to other packages.** It is the harness's CHANGELOG entry; it now says what the harness is.
