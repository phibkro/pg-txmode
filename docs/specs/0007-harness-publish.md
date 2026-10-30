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
| README | `packages/harness/README.md` ships (stage copies a package README when there is one; the others keep the generated one) | what it spawns (`initdb`, `postgres`, `pgbouncer`, from `PATH`), how to provide them (`nix shell`, devenv, CI image), temporary directories, free loopback ports, `stop()` |
| Release rules | the test "the harness stays private" becomes "all five are published, nothing is private"; the two "workspace:* to a private package" controls use a synthetic private name | the controls still fail what they failed before |

### Lockstep: all five at `0.1.0-alpha.1`

The harness joins the Changesets `fixed` group, so the group is again the published set (`release.test.ts`). Rehearsed (evidence section 3): a minor changeset on the harness alone makes `changeset version` give **all five** `0.1.0-alpha.1`; core, pg, effect and lint get "No changes in this release" in their CHANGELOG, and their shipped manifests change only in `version` and in the exact `@pg-txmode/core` pin.

Alternative: leave the harness out of the group at `0.1.0-alpha.0` and republish nothing. Rejected: the gated invariant (group = published set) and the exact internal pins are what keep a consumer from mixing versions; two version lines would be the first divergence, forever. The cost is four republished packages whose code is the same.

What the lockstep publish does to dist-tags, with the `Publish` step of spec 0006 (`npm publish --tag alpha` for each, core first, skipping a version the registry has):

- `alpha` moves to `0.1.0-alpha.1` on all five;
- `latest` of the four stays on `0.1.0-alpha.0` (observed on the local registry in spec 0006: later publishes with an explicit `--tag` do not move it; npm itself is not observed for this); `latest` of the harness is whatever the registry sets on a first publish (probably `0.1.0-alpha.1`; read it afterwards, as for the four);
- an install by `@alpha` gets a consistent set; an untagged install of core gets `0.1.0-alpha.0` and of the harness `0.1.0-alpha.1`, which are not a consistent pair: the README already says `latest` is unmanaged and `@alpha` is the one to use.

## Gates and falsifiers

| # | Falsifier | Gate | Control |
| --- | --- | --- | --- |
| F-h1 | The published set is the five packages, none private; the fixed group equals it | `release.test.ts` | (unchanged rule) the harness removed from the group fails it |
| F-h2 | A declaration file's `declare module "pkg"` needs the types of `pkg` to ship | `release:stage` (`importFindings`), unit test | `@types/pg` moved to `devDependencies` of the harness on the real tree: `@pg-txmode/harness: index.d.mts imports pg, and its types @types/pg are a devDependency, which does not ship`, exit 1 |
| F-h3 | The tarball installs, imports, starts a stack and type-checks in a project that is not this repository | evidence section 2 (needs the PostgreSQL and PgBouncer binaries; not a gate) | before the `@types/pg` fix: `tsc` exit 1, TS2665 |
| F-h4 | The stage copies a package README | `release:stage` listing (`README.md` of 2.8 kB in the harness tarball, the generated 250 B in the others) | n/a |
| F-h5 | A published package may not depend on a private one | `release.test.ts` | a synthetic private package (fixture) |

## Constraints and values

- No Effect; no secret; no publish by an agent; the token path and the `Release` workflow are untouched (they already publish every `packages/*/dist`).
- The harness is a test tool and says so: it starts processes and writes temporary directories. Nothing about it runs at import time.
- Not claimed: PostgreSQL or PgBouncer versions other than 18 and 1.25, Windows, a Node version other than 24.21.0, a Bun consumer.

## Operator steps

1. Merge this PR (nothing is published).
2. The version PR: a changeset for the harness, `bun run release:version` (all five at `0.1.0-alpha.1`).
3. The operator dispatches `mode=publish`; afterwards read `npm view @pg-txmode/<name> dist-tags` for the five.

## Revisions

- **2026-10-30, plan written** with the build. It supersedes the line of spec 0006 that keeps the harness private (a dated entry is added there too).
