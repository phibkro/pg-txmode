# Release evidence (spec 0006)

Measured on 2026-10-30 on the head of `feat/0006-release`, with Node 24.21.0, npm 11.19.0, Bun 1.4.2 and `@changesets/cli` 3.0.3. Nothing here touched the npm registry: every publish went to a local [Verdaccio](https://verdaccio.org/) 6.11.1 with a throwaway user. The raw output below is copied from the terminal; the commands are above each block.

## 1. Stage: what ships

```sh
devenv shell -- bun run release:stage
```

```text
$ bun tools/quality/stagePackages.ts
warn: TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.   (four times, one per package)
Staged @pg-txmode/core, @pg-txmode/effect, @pg-txmode/lint, @pg-txmode/pg.
```

`packages/lint/dist` after staging (the bin is built, not the TypeScript source):

```text
LICENSE  NOTICE  README.md  cli.d.mts  cli.mjs  extract-D8E-g69f.mjs  index.d.mts  index.mjs  package.json
```

`head -3 packages/lint/dist/cli.mjs`:

```text
#!/usr/bin/env node
import { c as lintStatements, i as extractFromLog, o as ScriptParseError, r as extractFromFile } from "./extract-D8E-g69f.mjs";
import { direct, hyperdrive, neonPooler, pgBouncer, sessionPooled, supavisor } from "@pg-txmode/core";
```

`packages/effect/dist/package.json` (the manifest that ships; `workspace:*` became the version, the peers are kept):

```json
"dependencies": { "@pg-txmode/core": "0.0.0" },
"peerDependencies": { "@effect/sql-pg": ">=4.1.0 <4.2.0", "effect": ">=4.1.0 <4.2.0" },
"exports": { ".": { "types": "./index.d.mts", "default": "./index.mjs" } }
```

## 2. `npm publish --dry-run` of each staged package

Run from `/tmp`, outside the repository (inside it npm stops with `EBADDEVENGINES`, see spec 0006).

```sh
cd /tmp && npm publish <worktree>/packages/<name>/dist --dry-run --tag alpha --access public
```

```text
== core     name: @pg-txmode/core    package size: 29.6 kB  unpacked size: 109.4 kB  total files: 8   + @pg-txmode/core@0.0.0
== pg       name: @pg-txmode/pg      package size: 10.0 kB  unpacked size: 29.0 kB   total files: 6   + @pg-txmode/pg@0.0.0
== effect   name: @pg-txmode/effect  package size: 11.6 kB  unpacked size: 40.0 kB   total files: 6   + @pg-txmode/effect@0.0.0
== lint     name: @pg-txmode/lint    package size: 14.0 kB  unpacked size: 43.1 kB   total files: 9   + @pg-txmode/lint@0.0.0
```

(Each line summarises the `npm notice` block; the full blocks end with `Publishing to https://registry.npmjs.org/ with tag alpha and public access (dry-run)`.) A dry run does not authenticate.

## 3. The tarballs, installed and used

```sh
for p in core pg effect lint; do npm pack <worktree>/packages/$p/dist; done
cd /tmp/pgtx-consume && printf '{"name":"consume","private":true,"type":"module"}\n' > package.json
npm install ./tarballs/pg-txmode-{core,pg,lint,effect}-0.0.0.tgz effect@4.1.0 @effect/sql-pg@4.1.0
node check.mjs                       # import every entry point
node_modules/.bin/pg-txmode-lint q.sql
tsc -p .                             # TypeScript 7 against the shipped .d.mts
```

```text
added 26 packages in 3s
core 45 exports
cancel 1 exports
pg 3 exports
lint 10 exports
eff 17 exports
q.sql:1:1  error  session-set  SET or RESET without LOCAL (SET search_path) on a transaction-pooled (hyperdrive) connection: ...
q.sql:2:8  error  session-advisory-lock  session-level advisory lock (pg_advisory_lock()) on a transaction-pooled (hyperdrive) connection: ...
1 statement(s) checked for hyperdrive: 2 error(s), 0 warning(s)
exit 1
```

`tsc -p .` over `t.ts` (imports from `@pg-txmode/core`, `/pg` and `/effect`): no output, exit 0. Negative control (`t2.ts` imports `nope` from `@pg-txmode/core`):

```text
t2.ts(1,10): error TS2305: Module '"@pg-txmode/core"' has no exported member 'nope'.
exit 1
```

**Found by this check (spec 0006, Revisions 1).** With `"skipLibCheck": false` the first run failed, and the fix is `@types/pg` as a dependency of `@pg-txmode/pg`:

```text
before: node_modules/@pg-txmode/pg/index.d.mts(2,38): error TS7016: Could not find a declaration file for module 'pg'. '/tmp/pgtx-consume/node_modules/pg/esm/index.mjs' implicitly has an 'any' type.
        node_modules/@pg-txmode/pg/index.d.mts(25,56): error TS2591: Cannot find name 'Buffer'.
        (and four TS2591 errors in @effect/sql-pg's own declarations: no Node types were installed)
        exit 1
after:  added 29 packages in 3s   (the packages re-packed; "@types/pg":"8.23.1" in the dependencies of @pg-txmode/pg)
        tsc -p .   exit 0
```

## 4. The version commit and `changeset publish`, rehearsed against a local registry

In a copy of the tree (`/tmp/pgtx-rehearse`): one changeset file for `@pg-txmode/core` (minor), then the steps of the Release workflow's `publish` job, with a Verdaccio user's token in `NODE_AUTH_TOKEN` (116 characters, never printed) and `NPM_CONFIG_USERCONFIG` pointing at a file that holds `//127.0.0.1:4873/:_authToken=${NODE_AUTH_TOKEN}`.

```sh
devenv shell -- bunx changeset version        # 0.1.0-alpha.0 for the four published packages; harness stays 0.0.0
devenv shell -- bun install --frozen-lockfile # passes: "Checked 324 installs across 474 packages (no changes)"
devenv shell -- bun run release:stage
jq 'del(.devEngines)' package.json > package.json.release && mv package.json.release package.json
NPM_CONFIG_USERCONFIG=/tmp/verdaccio/npmrc devenv shell -- bunx changeset publish --no-git-tag
```

```text
version: 0.1.0-alpha.0 (core, effect, lint, pg), 0.0.0 (harness)
dist/package.json: "@pg-txmode/core": "0.1.0-alpha.0" in effect, lint and pg

You are in prerelease mode, so packages will be published to the alpha npm tag,
except for packages that have not had normal releases, which will be published to latest.
Package @pg-txmode/core was not found in the registry.   (and pg, lint, effect)
◇  Successfully published:
@pg-txmode/core@0.1.0-alpha.0
@pg-txmode/effect@0.1.0-alpha.0
@pg-txmode/lint@0.1.0-alpha.0
@pg-txmode/pg@0.1.0-alpha.0
```

Dist-tags in the local registry afterwards (`curl http://127.0.0.1:4873/@pg-txmode%2f<name> | jq '."dist-tags"'`): `{"latest":"0.1.0-alpha.0","alpha":"0.1.0-alpha.0"}` for all four. Verdaccio sets `latest` on a first publish; what npm does is not observed (spec 0006, risks).

A second `changeset publish`: `No unpublished projects to publish.`

A fresh project with `registry=http://127.0.0.1:4873/` installed `@pg-txmode/{core,pg,lint,effect}@alpha effect@4.1.0 @effect/sql-pg@4.1.0` (`added 26 packages in 3s`); `npm ls @pg-txmode/core` shows `0.1.0-alpha.0` once, deduped under the three dependents; the import check and `pg-txmode-lint q.sql` give the output of section 3.

The rehearsal tree was copied before `@types/pg` became a dependency of `@pg-txmode/pg` (section 3, "Found by this check"); the version, stage and publish steps do not depend on it.

## 5. GitHub state, read only

```sh
gh secret list --repo phibkro/pg-txmode                       # repository secrets: none (empty output, exit 0)
gh api repos/phibkro/pg-txmode/environments/npm-release --jq '{name, protection: [.protection_rules[].type], branches: .deployment_branch_policy}'
gh api repos/phibkro/pg-txmode/environments/npm-release/secrets --jq '.secrets[].name'
```

```text
{"branches":{"custom_branch_policies":true,"protected_branches":false},"name":"npm-release","protection":["required_reviewers","branch_policy"]}
NPM_TOKEN
```

Names only; no value was read or can be read through these calls.

## 6. Controls: mutations of the real files, in a scratch copy

A copy of the tree in `/tmp/pgtx-mut` (`git init`, `bun install`), mutated with `sed`, each run followed by a restore. Each mutation must make a gate fail; the baseline and the restored tree pass.

`devenv shell -- bun run release:stage`:

```text
baseline                                   Staged @pg-txmode/core, @pg-txmode/effect, @pg-txmode/lint, @pg-txmode/pg.   exit 0
M1 `pg` removed from dependencies of pg    @pg-txmode/pg: index.d.mts imports pg, which is not in dependencies or peerDependencies
                                           @pg-txmode/pg: src/cancel.ts imports pg, which is not in dependencies or peerDependencies
                                           (and src/database.ts, session.ts, statement.ts, transaction.ts)   exit 1
M2 @types/pg moved to devDependencies      @pg-txmode/pg: index.d.mts imports pg, and its types @types/pg are a devDependency, which does not ship   exit 1
M3 "@probe/x": "workspace:^" in lint       @pg-txmode/lint: dependency @probe/x has the range workspace:^, which npm cannot resolve   exit 1
restored                                   Staged ...   exit 0
```

M1 shows why the sources are scanned and not only the built files: `index.mjs` is not in the list, because the bundler inlined `pg` into it and no import was left to see.

`cd tools/quality && devenv shell -- bunx vp test run test/releaseWorkflow.test.ts` after each edit of `.github/workflows/release.yml`:

```text
baseline                                       Tests  21 passed (21)
W1 NODE_AUTH_TOKEN renamed NPM_TOKEN           FAIL the real files > secretspec.toml and the workflows follow the token rule
W2 `npm publish` without --dry-run in check    FAIL the real files > the release workflow's check mode cannot reach a publish, for any mode or ref
                                               FAIL the real files > the check job dry-runs each package and holds no publish
                                               FAIL the release hold > the real hold step refuses where the file exists ... (the check job now publishes with no hold)
W3 `if: always()` on the Publish step          FAIL the release hold > the real hold step refuses where the file exists ...
W4 check job in environment `staging`          FAIL the real files > secretspec.toml and the workflows follow the token rule
W5 hold step tests `release-hold-x`            FAIL the release hold > the real hold step refuses where the file exists ...   (the run with the file exits 0)
W6 `default: publish`                          FAIL the real files > the release workflow's check mode cannot reach a publish, for any mode or ref
restored                                       Tests  21 passed (21)
```

## What this does not show

- The real npm registry: the `@pg-txmode` scope, the token's rights, provenance and OIDC. A local registry has none of them.
- `NPM_CONFIG_PROVENANCE=true`: a provenance attestation needs GitHub's OIDC token ([docs](https://docs.npmjs.com/generating-provenance-statements)), so the rehearsal did not set it. The workflow sets it on `publish` only.
