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
== effect   name: @pg-txmode/effect  package size: 11.6 kB  unpacked size: 39.9 kB   total files: 6   + @pg-txmode/effect@0.0.0
== lint     name: @pg-txmode/lint    package size: 13.9 kB  unpacked size: 43.0 kB   total files: 9   + @pg-txmode/lint@0.0.0
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
added 29 packages in 3s
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

## 4. Versioning and publishing, rehearsed twice against a local registry

Verdaccio 6.11.1 on 127.0.0.1:4873 with a throwaway user; a 116-character token in `NODE_AUTH_TOKEN` (never printed); `NPM_CONFIG_USERCONFIG` points at a file that holds `//127.0.0.1:4873/:_authToken=${NODE_AUTH_TOKEN}`. Each scenario ran in a fresh copy of the tree at the head (`/tmp/pgtx-rh`), with a fresh registry. Two releases: a changeset file (`@pg-txmode/core` minor, then patch), `changeset version`, `bun run release:stage`, then the publish.

### A. `changeset publish`, twice (the defect of round 1, reproduced)

```sh
jq 'del(.devEngines)' package.json > package.json.r && mv package.json.r package.json
bunx changeset version; bun run release:stage; bunx changeset publish --no-git-tag     # release 1: 0.1.0-alpha.0
# a second changeset file, then the same three commands                                 # release 2: 0.1.0-alpha.1
curl -s http://127.0.0.1:4873/@pg-txmode%2f<name> | jq -c '."dist-tags"'
```

```text
release 2:  @pg-txmode/pg@0.1.0-alpha.1
            └ will be published to latest rather than alpha as it will be its first published version.
core    {"latest":"0.1.0-alpha.1","alpha":"0.1.0-alpha.0"}
pg      {"latest":"0.1.0-alpha.1","alpha":"0.1.0-alpha.0"}
effect  {"latest":"0.1.0-alpha.1","alpha":"0.1.0-alpha.0"}
lint    {"latest":"0.1.0-alpha.1","alpha":"0.1.0-alpha.0"}
```

After release 2 the `alpha` tag is one release behind: `npm i @pg-txmode/core@alpha` would install the first alpha. (The reviewer also reports that `changeset publish --tag alpha` is refused in pre mode: "Releasing under custom tag is not allowed in pre mode!".)

### B. The `Publish` step of `release.yml`, twice and once more

The step's `run` text, read from the workflow with the `yaml` package into `/tmp/publish-step.sh`, run as it is (it calls `devenv shell -- bash -c '...'`):

```sh
bunx changeset version; bun run release:stage; bash /tmp/publish-step.sh    # release 1: 0.1.0-alpha.0
# second changeset file, same three commands                                # release 2: 0.1.0-alpha.1
bash /tmp/publish-step.sh                                                   # re-run
```

```text
release 1:  + @pg-txmode/core@0.1.0-alpha.0  + @pg-txmode/effect@0.1.0-alpha.0  + @pg-txmode/lint@0.1.0-alpha.0  + @pg-txmode/pg@0.1.0-alpha.0
            (npm notice: "Publishing to http://127.0.0.1:4873/ with tag alpha and public access", for each)
release 2:  + @pg-txmode/core@0.1.0-alpha.1  + ...effect, lint, pg ...@0.1.0-alpha.1   (tag alpha for each)
re-run:     @pg-txmode/core@0.1.0-alpha.1 is on the registry: skipped   (effect, lint, pg likewise)
core    {"latest":"0.1.0-alpha.0","alpha":"0.1.0-alpha.1"}
pg      {"latest":"0.1.0-alpha.0","alpha":"0.1.0-alpha.1"}
effect  {"latest":"0.1.0-alpha.0","alpha":"0.1.0-alpha.1"}
lint    {"latest":"0.1.0-alpha.0","alpha":"0.1.0-alpha.1"}
```

`alpha` follows each release. `latest` stayed on `0.1.0-alpha.0`: the registry (Verdaccio) set it on the first publish, and nothing moves it (spec 0006, Revisions 5). npm's own behaviour on a first publish with `--tag alpha` is not observed.

`changeset version` in both scenarios gave `0.1.0-alpha.0`, then `0.1.0-alpha.1`, to the four packages and left the harness at `0.0.0`. That `bun install --frozen-lockfile` passes after the version commit was checked in the first rehearsal of this PR (no change to manifests or lock since, except the dependency ranges of the shipped `dist`, which the lock does not see).

A fresh project with `registry=http://127.0.0.1:4873/` (and an empty user config) installed `@pg-txmode/{core,pg,lint,effect}@alpha effect@4.1.0 @effect/sql-pg@4.1.0`:

```text
added 29 packages in 5s
├── @pg-txmode/core@0.1.0-alpha.1
├─┬ @pg-txmode/effect@0.1.0-alpha.1 ...
1 statement(s) checked for hyperdrive: 1 error(s), 0 warning(s)            (pg-txmode-lint q.sql, SET search_path)
{"@pg-txmode/core":"0.1.0-alpha.1","@types/pg":"^8.23.1","pg":"^8.23.1"}   (dependencies of the installed @pg-txmode/pg)
```

Also found here (spec 0006, Revisions 8): `npm publish ./dist` warned `"bin[pg-txmode-lint]" script name cli.mjs was invalid and removed` for `"bin": {"pg-txmode-lint": "./cli.mjs"}`; with `"cli.mjs"` there is no warning (`npm publish . --dry-run 2>&1 | grep -ci warn`: 3 before, 0 after). The tarball kept its bin either way (`pg-txmode-lint` linked to `cli.mjs` in a consumer).

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

`cd tools/quality && devenv shell -- bunx vp test run test/releaseWorkflow.test.ts` after each edit of `.github/workflows/release.yml` (round 1 of PR #11; the gates were tightened first, Revisions 6):

```text
baseline                                              Tests  29 passed (29)
V1 a second step of the check job reads the token     FAIL the real files > secretspec.toml and the workflows follow the token rule
V2 `export -p` in the token step                      FAIL the real files > secretspec.toml and the workflows follow the token rule
V3 `--dry-run=false` in the check job                 FAIL the real files > the release workflow's check mode cannot reach a publish, for any mode or ref
V4 `npm publish ... # --dry-run` (a comment)          FAIL the real files > the release workflow's check mode cannot reach a publish ...   (and two more)
V5 `bunx changeset publish` back in the Publish step  FAIL the publish step > ...   (5 failed: tag, skip, latest, stop at first failure, no changeset publish)
V6 `--tag latest` hard-coded in the Publish step      FAIL the publish step > ...   (3 failed)
restored                                              Tests  29 passed (29)
```

## 7. What `npm view` answers on the real registry (read only, 2026-10-30, from `/tmp`)

```sh
npm view zod@9.9.9 version; echo "exit $?"                        # a package that exists, a version that does not
npm view @pg-txmode/nonexistent-xyz@1.0.0 version; echo "exit $?"  # a package that does not exist
npm view @pg-txmode/core@0.1.0-alpha.0 version; echo "exit $?"     # the real name, not published yet
```

```text
npm error code E404
npm error 404 No match found for version 9.9.9
... exit 1
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@pg-txmode%2fnonexistent-xyz - Not found
... exit 1
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@pg-txmode%2fcore - Not found
... exit 1
```

The `Publish` step publishes only on output with `E404`. As of this reading `@pg-txmode/core` does not exist on npm. The step's tests (stubs) cover a non-E404 error (printed, nothing published) and a refused name (E403 on `effect` after `core`: the set stops, and a re-run skips `core` and publishes `effect`, `lint`, `pg`).

## 8. The version commit (`changeset version`) and the tarballs it gives

```sh
devenv shell -- bunx changeset version                 # one changeset file for the four packages
devenv shell -- bun install --frozen-lockfile          # Checked 324 installs across 474 packages (no changes)
devenv shell -- bun run release:stage                  # Staged @pg-txmode/core, @pg-txmode/effect, @pg-txmode/lint, @pg-txmode/pg.
cd /tmp && npm publish <worktree>/packages/<name>/dist --dry-run --tag alpha --access public
```

`"version"` of the manifests: core, pg, effect, lint `0.1.0-alpha.0`; harness `0.0.0`. Each `dist` now has a `CHANGELOG.md`. Raw `npm notice` output (dry run, no `npm warn`):

```text
== core    @pg-txmode/core@0.1.0-alpha.0    package size: 29.8 kB  unpacked size: 109.7 kB  total files: 9
            CHANGELOG.md 294B  LICENSE 11.4kB  NOTICE 127B  README.md 305B  cancel.d.mts 813B  cancel.mjs 1.2kB  index.d.mts 43.1kB  index.mjs 51.8kB  package.json 817B
== pg      @pg-txmode/pg@0.1.0-alpha.0      package size: 10.2 kB  unpacked size: 29.4 kB  total files: 7
            CHANGELOG.md 369B  LICENSE 11.4kB  NOTICE 127B  README.md 268B  index.d.mts 7.1kB  index.mjs 9.4kB  package.json 801B
== effect  @pg-txmode/effect@0.1.0-alpha.0  package size: 11.8 kB  unpacked size: 40.3 kB  total files: 7
            CHANGELOG.md 373B  LICENSE 11.4kB  NOTICE 127B  README.md 241B  index.d.mts 12.0kB  index.mjs 15.4kB  package.json 829B
== lint    @pg-txmode/lint@0.1.0-alpha.0    package size: 14.1 kB  unpacked size: 43.4 kB  total files: 10
            CHANGELOG.md 371B  LICENSE 11.4kB  NOTICE 127B  README.md 252B  cli.d.mts 9B  cli.mjs 3.2kB  extract-D8E-g69f.mjs 21.7kB  index.d.mts 5.3kB  index.mjs 251B  package.json 867B
```

## What this does not show

- The real npm registry: the `@pg-txmode` scope, the token's rights, provenance and OIDC. A local registry has none of them.
- `NPM_CONFIG_PROVENANCE=true`: a provenance attestation needs GitHub's OIDC token ([docs](https://docs.npmjs.com/generating-provenance-statements)), so the rehearsal did not set it. The workflow sets it on `publish` only.
