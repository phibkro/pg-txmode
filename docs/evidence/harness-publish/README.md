# Harness publish evidence (spec 0007)

Measured 2026-10-30 on `feat/0007-harness-publish`, Node 24.21.0, npm 11.19.0, inside `devenv shell` (PostgreSQL 18, PgBouncer 1.25 on `PATH`). Nothing touched the npm registry except read-only `npm view`.

## 1. Stage and dry-run publish

```sh
devenv shell -- bun run release:stage
cd /tmp && npm publish <worktree>/packages/harness/dist --dry-run --tag alpha --access public
```

```text
Staged @pg-txmode/core, @pg-txmode/effect, @pg-txmode/harness, @pg-txmode/lint, @pg-txmode/pg.
Tarball Contents: CHANGELOG.md 385B  LICENSE 11.4kB  NOTICE 127B  README.md 4.2kB  cli.d.mts 9B  cli.mjs 2.3kB  index.d.mts 8.2kB  index.mjs 1.9kB  matrix-D053EUrv.mjs 42.9kB  package.json 886B
package size: 22.3 kB   unpacked size: 72.1 kB   total files: 10   (no npm warn; measured on the head of spec 0008, after release:stage; the first figures, 20.9 kB and 68.4 kB, were of the first commit of #15, before the watchdog)
```

`cli.mjs` starts with `#!/usr/bin/env node`; the manifest has `"bin": {"pg-txmode-harness": "cli.mjs"}`, dependencies `@pg-txmode/core`, `@types/pg`, `pg`.

## 2. The tarball in a project that is not this repository

```sh
cd /tmp/pgtx-h && npm install ./t/pg-txmode-core-0.1.0-alpha.0.tgz ./t/pg-txmode-harness-0.0.0.tgz
node c.mjs        # startStack(3); session.query("select 1::int as one"); print the pooler url; stop()
tsc -p .          # TypeScript 7, skipLibCheck false, imports startStack, pgConnect, probes
node node_modules/.bin/pg-txmode-harness probes | tail
```

Before `@types/pg` was a dependency of the harness:

```text
node_modules/@pg-txmode/harness/index.d.mts(47,16): error TS2665: Invalid module name in augmentation. Module 'pg' resolves to an untyped module at '/tmp/pgtx-h/node_modules/pg/esm/index.mjs', which cannot be augmented.
tsc 1
```

After (the stage also fails now when it is absent, section 4):

```text
[ { one: 1 } ] postgres://app@127.0.0.1:42161/app
added 19 packages in 768ms
tsc 0
```

`pg-txmode-harness probes` (run on the tarball made before the fix; the runtime code is unchanged by it) ended with `ok   pattern-retry  direct works  pooled works  (catalogue row sqlstate-passthrough)` and exit 0.

## 3. Lockstep: the version commit with the harness in the fixed group

A scratch copy (`/tmp/pgtx-lock`), harness without `private`, `fixed` of five, one changeset `"@pg-txmode/harness": minor`:

```sh
devenv shell -- bunx changeset version
grep -H '"version"' packages/*/package.json
```

```text
packages/core/package.json:    "version": "0.1.0-alpha.1",
packages/effect/package.json:  "version": "0.1.0-alpha.1",
packages/harness/package.json: "version": "0.1.0-alpha.1",
packages/lint/package.json:    "version": "0.1.0-alpha.1",
packages/pg/package.json:      "version": "0.1.0-alpha.1",
core CHANGELOG: "## 0.1.0-alpha.1 / No changes in this release."
harness CHANGELOG: "## 0.1.0-alpha.1 / Minor Changes: Harness published. / Patch Changes: @pg-txmode/core@0.1.0-alpha.1"
```

## 4. Control on the real tree

`@types/pg` moved from `dependencies` to `devDependencies` of `packages/harness/package.json`:

```text
$ bun tools/quality/stagePackages.ts
@pg-txmode/harness: index.d.mts imports pg, and its types @types/pg are a devDependency, which does not ship
error: script "release:stage" exited with code 1
```

Restored: `Staged @pg-txmode/core, @pg-txmode/effect, @pg-txmode/harness, @pg-txmode/lint, @pg-txmode/pg.`

## Not shown

The real registry (names, scope, token), a Node or Bun consumer other than Node 24.21.0, PostgreSQL or PgBouncer versions other than 18 and 1.25, any platform but Linux.
