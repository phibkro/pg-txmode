# 0006 Publish `@pg-txmode/*` pre-releases to npm

Status: **spec** (frozen when its PR opens). Date: 2026-10-30. Decided by: the operator, 2026-10-30 (the token `NPM_TOKEN` is set in the GitHub environment `npm-release` of `phibkro/pg-txmode`; the environment is restricted to `main` with the reviewer `phibkro`), and the lead's approval of this design.
Process: [spec 0000](0000-development-lifecycle.md). Based on `main` (specs 0000 to 0005 merged). Numbered 0006 by agreement. Follows `tsukuri-labs/tsukuri` spec 0009 and its PR #29 (merge commit `d0c5a1de330200302edbad58784f351b09eeb4f8`), read on 2026-10-30; [`PROVENANCE.md`](../../PROVENANCE.md) lists what was ported and how it differs.
Verify skill: `verify-pg-txmode` (updated in this PR: a path-table row for the release files).

## Problem

The packages exist only in this repository: every manifest says `private`, `exports` point at `.ts` sources, and nothing builds what a consumer installs. A project that wants the catalogue, the connection mode, the `pg` adapter, the Effect adapter or the lint cannot install them.

## Goal

A maintainer runs one workflow on `main`, after a version commit, and four packages appear on npm as `0.1.0-alpha.N` under the dist-tag `alpha`, built (ESM and declarations), with a provenance attestation, published by GitHub Actions. **This PR publishes nothing and bumps no version.** It builds the path, proves it as far as it can be proved without the registry, and ships it **held** (`.github/release-hold`).

```text
bun run release:stage            builds packages/<name>/dist for the four published packages and refuses anything that should not ship
bun run release:version          changeset version: 0.1.0-alpha.N in lockstep, a CHANGELOG.md per package   (the next PR)
Actions > Release > Run workflow  mode=check    dry-run publish of each package, the token's identity and reach; publishes nothing
                                  mode=publish  npm publish of each dist, --tag alpha  (held while .github/release-hold exists; not held since Revisions 13)
npm i @pg-txmode/core@alpha @pg-txmode/pg@alpha @pg-txmode/lint@alpha @pg-txmode/effect@alpha
```

## Journey

```sh
git checkout feat/0006-release
devenv shell -- bun install
devenv shell -- bun run release:stage                         # four dist directories, a clean tarball listing, every import declared
cd /tmp && npm publish <repo>/packages/core/dist --dry-run --tag alpha --access public     # outside the repository, see "Decisions"
cd tools/quality && devenv shell -- bunx vp test run          # the token, mode, hold and manifest rules and their controls
```

Then read [`docs/evidence/release/README.md`](../evidence/release/README.md): the tarballs installed and used, and the whole version-and-publish path run against a local registry.

## Decisions

### Which packages are published

| Package | Published | Why |
| --- | --- | --- |
| `@pg-txmode/core` | yes | The catalogue, the mode, the constructs. Two entries: `.` and `./cancel`. |
| `@pg-txmode/pg` | yes | The node-postgres adapter. It ships `@types/pg` as a dependency: its declarations import `pg`, which has no types of its own (found by a consumer check without `skipLibCheck`, Revisions 1). |
| `@pg-txmode/effect` | yes | The Effect adapter. `effect` and `@effect/sql-pg` are peers, `>=4.1.0 <4.2.0`: the adapter uses `@stability unstable` modules (its `tsconfig.json` lists them in `allowedUnstableApis`), which may break in a minor release; a caret would admit 4.2. `release.test.ts` fails an unbounded peer. |
| `@pg-txmode/lint` | yes | The SQL lint and its CLI `pg-txmode-lint`. The bin is **built** (`cli.mjs`, first line `#!/usr/bin/env node`, set by `release:stage`: the source's shebang names Bun) and was run from an installed tarball (evidence section 3). |
| `@pg-txmode/harness` | **no** | It starts PostgreSQL and PgBouncer processes and exists to test the others. Nobody needs it from npm; a published harness would also have to say which server binaries it expects. |
| `@pg-txmode/quality` | no | Repository tooling. |

The set has one source: a package is published when its manifest has no `"private": true` (the Changesets rule). `release.test.ts` fails when the Changesets `fixed` group differs from that set, and when a published package depends on one that is not published.

### Versioning: Changesets 3.0.3, pre mode `alpha`, lockstep

`@changesets/cli` is pinned exactly and **only versions** (`changeset version`); it does not publish (Revisions 5). `.changeset/pre.json` (committed) is `{ "mode": "pre", "tag": "alpha" }`; one `fixed` group holds the four packages, so they share a version, and every internal dependency in a shipped manifest is that exact version. `privatePackages` is `{ tag: false, version: false }`: the harness and the tooling keep `0.0.0`. No git tags are created. The version commit is the next PR; this one leaves every version at `0.0.0`.

Rehearsed against a local registry (evidence section 4): one changeset file gave `0.1.0-alpha.0` to the four packages and left the harness at `0.0.0`; `bun install --frozen-lockfile` passed; the `Publish` step published the four under `alpha`; a second release (`0.1.0-alpha.1`) went to `alpha` as well, and a re-run said `is on the registry: skipped` for all four; a fresh project installed them with `@alpha` and used them.

### The stage step: `dist` is the package root

`bun run release:stage` (`tools/quality/stagePackages.ts`, rules in `release.ts`) for each published package:

1. `vp pack <exports and bin> --dts --out-dir dist` (tsdown): one `.mjs` and one `.d.mts` per entry, shared code in a chunk. Dependencies and peers stay external.
2. Writes `dist/package.json` from the source manifest: `exports` as `{ types, default }` (in that order: TypeScript takes the first condition that matches), `bin` pointing at the built file (as `cli.mjs`, the form npm stores), `workspace:*` rewritten to the exact version (lockstep) and `catalog:` to a caret range on the catalog's version (a library does not pin its consumer's copy of `pg` or `zod`), `repository` (with `directory`), `homepage` and `bugs` from the root, `publishConfig: { access: "public" }`. Any other `workspace:` or `catalog:` form, a missing licence or description, an export that is not `./src/*.ts`, or two exports that build to one name **fail** the stage. `devDependencies` and `scripts` do not ship, and no `engines` field: nothing here measured a Node floor.
3. Copies `LICENSE` and `NOTICE` (the Apache-2.0 terms the repository carries), writes a short `README.md`, and copies `CHANGELOG.md` when Changesets wrote one.
4. Runs `npm pack --dry-run --json` on a copy and **fails on any file that is not** `*.mjs`, `*.d.mts`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE` or `NOTICE`.
5. Fails when a built file or a source file (`src/**/*.ts`, which the bundler reads: an import of a development dependency there is inlined and leaves no import in the built file) imports a package that the manifest neither depends on nor has as a peer, and when a declaration file imports a package whose types are a development-only `@types/*`.

Each source manifest has `publishConfig: { access: "public", directory: "dist" }` (`directory` is how Changesets and npm tools find what to publish; the `Publish` step names the directory itself). Its `prepublishOnly` script exits 1 with the instruction, so a hand-run `npm publish` in the source directory cannot ship sources (a test runs each script).

**One finding the workflow handles.** `npm` stops in any directory below a root `package.json` whose `devEngines.packageManager` names another tool (`EBADDEVENGINES`: this repository's root names Bun and declares `workspaces`). The `check` job therefore runs its dry run from `$RUNNER_TEMP`, and the `publish` job removes `devEngines` from the runner's checkout with `jq` before it publishes (the checkout is discarded). The repository's own `devEngines` stays: the local toolchain uses it.

### The workflow `release.yml`

Adapted from `tsukuri-labs/tsukuri`'s `release.yml`. `workflow_dispatch` only, input `mode` (`choice`: `check` or `publish`, default `check`), concurrency group `release`, `permissions: contents: read`. Both jobs run in the environment `npm-release` and only on `refs/heads/main`.

- **`check`**: checkout, the pinned Nix, Cachix and devenv steps of `checks.yml`, `bun install --frozen-lockfile`, `bun run release:stage`, then `npm publish <dist> --dry-run --tag <tag> --access public` for each package from outside the checkout (the tag is read from `.changeset/pre.json`), then a user npm config file and **one** step with the token: `npm whoami`, `npm access list packages @pg-txmode --json`, `npm org ls pg-txmode --json`, and `result: pass|fail` (fail when `npm whoami` fails). It prints no value of the token, cannot print its expiry, and says that write access is not shown. **A dry run does not authenticate**, so it does not test the token or the right to create the `@pg-txmode` scope; only the first real publish proves those.
- **`publish`**: `id-token: write`, `NPM_CONFIG_PROVENANCE=true`; checkout, **Release hold**, the `checks` check-run of the commit must be `success`, Nix and devenv, `bun install --frozen-lockfile`, npm at least 11.5.1, `release:stage`, the npm config file, a step that removes `devEngines` from the checkout, then **`Publish`**: for each `packages/*/dist`, `npm view <name>@<version>` and, when it is not on the registry, `npm publish ./packages/<name>/dist --tag <tag> --access public` (alphabetical, so `core` first), with the token as `NODE_AUTH_TOKEN` of that step. `<tag>` is the tag of `.changeset/pre.json` while its mode is `pre`, else `latest`. Changesets is not used to publish: see Revisions 5.

The token reaches npm through `$RUNNER_TEMP/npmrc`, which holds `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` (single-quoted: the shell does not expand it, npm does). The value is never written to a file or a `run` body. `secretspec.toml` declares the one secret by name.

OIDC stays the target: npm tries trusted publishing first and uses the token only when the package has no trusted publisher, so configuring one needs no workflow change ([npm: trusted publishing](https://docs.npmjs.com/trusted-publishers), read 2026-10-30: npm CLI 11.5.1 or later and Node 22.14.0 or later; "The npm CLI automatically detects OIDC environments and uses them for authentication before falling back to traditional tokens"). The workflow file name `release.yml`, the environment `npm-release` and the `repository.url` of every shipped manifest (`git+https://github.com/phibkro/pg-txmode.git`, which npm requires to match the repository exactly) are what npm matches.

**A deadline.** [npm: about access tokens](https://docs.npmjs.com/about-access-tokens) (read 2026-10-30): "The ability to publish new package versions directly with a granular access token will be removed in **January 2027**", with the advice to move to a stage-only token and `npm stage publish` (a maintainer approves each staged version with 2FA). The token path is a bridge of weeks. Stage-only publishing is a possible later design (a human approves each release); it is not built here.

### The release hold

`.github/release-hold` holds the release while it exists (**it does not exist since Revisions 13**; the mechanism stays). The `Release hold` step of `publish` follows the checkout (the only step allowed before it), fails with the file's text, and every later step is skipped. `check` is not held. **Lifting** was one pull request that deleted the file and added a dated entry here. Merging a PR publishes nothing: only a `workflow_dispatch` run in `publish` mode does.

### Gates (rules in code, with a control each)

| # | Falsifier | Gate | Control that must fail it |
| --- | --- | --- | --- |
| F-rel1 | Every published package yields a complete manifest: no `workspace:` or `catalog:` left, the licence, `access: public`, `.ts` exports mapped, `types` before `default` | `release.test.ts`, `release:stage` | `workspace:*` to the harness, an unknown catalog name, `workspace:^`, `catalog:default`, a licence `MIT`, a missing description or access, an export `./index.js`, two exports that build to `index.mjs`, a version `workspace:*` |
| F-rel2 | Only built output ships | `release:stage` (`npm pack --dry-run --json`), `strayFiles` | source, tests, maps, build info, nested files, `.npmrc` in a listing |
| F-rel3 | Every import of a built file or of a source file resolves for a consumer | `importFindings` in `release:stage`, unit tests | an undeclared `left-pad`; a declaration importing `pg` whose `@types/pg` is a development dependency (the real defect of Revisions 1); on the real tree: `pg` removed from the dependencies of `@pg-txmode/pg` (evidence section 6, M1: the bundler inlines it, so only the sources show it) |
| F-rel4 | Changesets versions exactly the published set, in lockstep, in pre mode `alpha`; no published package depends on a private one | `release.test.ts` | the harness in the group or as a dependency (fixture) |
| F-rel5 | A package that uses unstable Effect APIs bounds its peers below the next minor | `release.test.ts` | a caret, an open `>=4.1.0` (fixtures) |
| F-rel6 | A package cannot be published from its source directory | `release.test.ts` runs each `prepublishOnly` | n/a (the script exits 1) |
| F-rel7 | The token rule: `secretspec.toml` declares exactly one secret and the workflows read exactly that name; only in a job of environment `npm-release`; only as `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` in **one** step of a job (a second step fails); never at workflow or job level, in `run` or `with`, as a literal `npm_…` token or an `_authToken` that is not the variable; a step that holds it does not run a printer from a deny-list (`NODE_AUTH_TOKEN`, `printenv`, `env`, `export`, `declare -x/-p`, `typeset`, a bare `set`, `set -x`, `compgen -e`, `/proc/*/environ`, `process.env`): a guard against a slip, not a proof | `releaseWorkflow.test.ts`, on fixtures and on the real files | a renamed secret on either side, a second declaration, a staging environment, workflow and job level, a second token step, `echo $NODE_AUTH_TOKEN`, `printenv`, `export -p`, `declare -x`, `set`, `compgen -e`, `/proc/self/environ`, `process.env`, `npm whoami && env`, a literal token, a literal `_authToken`, another variable name, a TOML that does not parse; real file: a second token step (V1), `export -p` (V2) |
| F-rel8 | Only `mode=publish` on `main` reaches a publish command; `check` never does (a command is a dry run only when it has a bare `--dry-run`: `--dry-run=false`, `--dry-run false` and `--no-dry-run` are publishes; shell comments are removed first; the script is split at `;`, `&&`, `\|\|` and `\|`, so a dry run cannot excuse a publish beside it); the input is a `choice` of exactly `check` and `publish` defaulting to `check`; no job needs a publisher; a condition the gate cannot read fails | `releaseWorkflow.test.ts`, every mode and ref | no mode condition, `!=`, no ref condition, `npm publish` in `check`, `npm publish && npm publish --dry-run`, `npm publish ; echo --dry-run`, `--dry-run=false`, `--dry-run false`, `--dry-run --no-dry-run`, `# --dry-run`, `echo "#"; npm publish # --dry-run`, `needs: publish`, default `publish`; real file: `--dry-run=false` (V3), a trailing `# --dry-run` (V4) |
| F-rel11 | Every release goes to the tag of pre mode, not only the first: the `Publish` step publishes with `--tag alpha` while `.changeset/pre.json` is in pre mode (else `latest`), skips a version the registry has, stops at the first failure, and never calls `changeset publish` | `releaseWorkflow.test.ts` runs the real step in a scratch repository with stubs for `devenv` and `npm`; evidence section 4 B (two releases against a local registry) | no `pre.json`; `mode: exit`; a failing publish; the step edited back to `bunx changeset publish` (V5) or to a hard-coded `--tag latest` (V6); the defect itself, reproduced in evidence section 4 A |
| F-rel9 | The hold stops the publish: the step exists, nothing but the checkout precedes it, no `continue-on-error` on the job or the step, no `if` on it or later; and the real step's script **run** in two temporary directories exits 0 without the file and 1 with it | `releaseWorkflow.test.ts` | no hold step, a step before it, `continue-on-error`, `if: always()`, `if: ${{ !cancelled() }}` |
| F-rel10 | The tarballs install, import, run and type-check in a project that is not this repository; the version commit and the `Publish` step work end to end, twice | evidence file (not a gate: it needs the network) | `tsc` of an import that does not exist fails (`TS2305`) |

The rules sit in `tools/quality/release.ts` and `releaseWorkflow.ts`, plain TypeScript (no Effect: the tooling follows the core), with `zod`, `yaml` and `smol-toml` as the parsers.

## Constraints and values

- No Effect outside `packages/effect`; no secret value anywhere in the repository (the repository is public); no publish by an agent; no `--no-verify`.
- Every claim has a URL or a local measurement; what was not observed is said under "Not claimed".
- One source per fact: the published set comes from `private`; the token name from `secretspec.toml`; the repository URL, licence and homepage from the root manifest.
- Dependencies added to the repository: `@changesets/cli` 3.0.3 (MIT, root, build time), `yaml` 2.9.1 (ISC) and `smol-toml` 1.9.1 (BSD-3-Clause) in `tools/quality`. [`PROVENANCE.md`](../../PROVENANCE.md) lists them.

## Operator steps (external effects: not done here)

1. Merge this PR. Nothing is published.
2. A separate PR adds one changeset and runs `bun run release:version`: `0.1.0-alpha.0`, CHANGELOGs, `.changeset/pre/`.
3. The operator dispatches **Release, `mode=check`** (Actions > Release > Run workflow). Read the result: the dry-run tarball listing of four packages, the token's user, and whether `npm access list packages @pg-txmode` and `npm org ls pg-txmode` can read.
4. ~~A PR deletes `.github/release-hold`~~ Done by the PR of Revisions 13.
5. The operator dispatches `mode=publish`: the first publish of each name creates it. If it fails with E403 or E404 the token lacks permission to create packages in the scope; that was not checked (the docs read name scopes and packages; no run). **Afterwards**: read `npm view @pg-txmode/<name> dist-tags` for each package (the `check` mode prints it too) and decide whether `latest` should stay on `0.1.0-alpha.0`.
6. Later: configure trusted publishers, then the removal checklist below.

## Not claimed

- Anything about the real registry: the scope `@pg-txmode` exists or the token may create in it; provenance and OIDC work for this repository; npm sets `latest` on a first publish with `--tag alpha` (the local registry did).
- That `engines`, Node 22 or Bun consumers work: the evidence is Node 24.21.0 and npm 11.19.0.
- Browser or workerd use of the published `core` (the code is portable; nothing here ran it there).
- Stable (`latest`) releases and `changeset pre exit`.

## Risks

- **The first publish is the only proof of the token's reach.** A real run could publish one name and fail another (E403 or E404 on a name the token may not create). The `Publish` step skips a version that `npm view` finds, so a re-run after the token is fixed publishes the rest (observed against the local registry: `is on the registry: skipped`, not on npm).
- **`latest` is not ours.** See Revisions 5 and 10: the registry decides it on a first publish; what npm does is not observed.
- **The token is a bridge.** It expires, and direct token publishing ends in January 2027.
- **Hidden duplicates.** A repository secret named `NPM_TOKEN` would be shadowed by the environment secret only inside jobs that name the environment; no file shows it. `gh secret list --repo phibkro/pg-txmode` must list none.
- **`vp pack` is young.** The declarations are produced by the experimental TypeScript 7 declaration emit (`warn: TypeScript 7.0 does not yet have a stable API and is experimental`); the consumer check above is the guard.

## Removal checklist, when trusted publishing is set up

Order matters: npm's rule is that a new trusted-publisher configuration must complete its first successful publish within 2 days or it expires and cannot be used or edited ([docs](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)). (1) Merge the removal PR first (after it no workflow uses the token, so no publish can happen until step 2: the intended pause): delete the `check` job (without a token it fails at `npm whoami`, and `npm whoami` is no check of trusted publishing, per the same page), the `npm credentials file` and token env of `publish`, the `mode` input or its `check` option with the mode rules adjusted, `secretspec.toml`, and the token rules of `releaseWorkflow.ts` that go with them. (2) Configure a trusted publisher on npmjs.com for each package (organisation `phibkro`, repository `pg-txmode`, workflow `release.yml`, environment `npm-release`). (3) Publish a new version with `mode=publish` within 2 days: the first successful publish validates them. (4) Set each package to "Require two-factor authentication and disallow tokens", delete the environment secret, and revoke the token on npmjs.com.

## Revisions

- **2026-10-30, plan written** with the build.
- **2026-10-30, found while building.**
  1. **`@types/pg` must ship.** Installing the four tarballs into a scratch project and running `tsc` **without** `skipLibCheck` failed: `node_modules/@pg-txmode/pg/index.d.mts(2,38): error TS7016: Could not find a declaration file for module 'pg'`, and `Cannot find name 'Buffer'`. The adapter's declarations import `pg`, which ships no types, and `@types/pg` was a development dependency. It is now a dependency of `@pg-txmode/pg` (it brings `@types/node`); the same check passes (exit 0); `importFindings` now fails this class. A control for it is in the test.
  2. **A `--dry-run` publish is not a publish** for the mode gate. The `check` job runs `npm publish --dry-run`, so the first gate (any `npm publish` in `check` fails) would have rejected it; the gate now ignores a command with `--dry-run` and splits a script at `;`, `&&`, `||` and `|` so a dry run cannot excuse a publish beside it (controls in the test).
  3. **`release:stage` is in `ready` and CI** (a `Stage release packages` step in `checks.yml`): a manifest that cannot ship fails every PR, not only a release.
  4. **No `engines` field ships.** The root manifest names Node 24; a library `engines` of `>=24` would refuse installs where nothing was shown to need it.
- **2026-10-30, after review round 1 of PR #11 (recorded by `RevPgTx3` at `fcc14d8`).**
  5. **`changeset publish` does not keep the `alpha` tag (high).** In pre mode it gives `alpha` to the first publish of a package only: `getReleaseTag` returns `latest` for a package whose registry entry already has a `latest` dist-tag and only alpha versions, and `changeset publish --tag alpha` is refused in pre mode. Rehearsed twice against a local registry (evidence section 4, A): after the second release `core` had `{latest: 0.1.0-alpha.1, alpha: 0.1.0-alpha.0}`, so `npm i @pg-txmode/core@alpha` would install the first alpha from the second release on, and this spec's Goal and the workflow comment were false. **Fix:** Changesets only versions. The `Publish` step publishes each `dist` with `npm publish ./packages/<name>/dist --tag <tag> --access public`, skipping a version `npm view` finds, stopping at the first failure, with `<tag>` = the tag of `.changeset/pre.json` while its mode is `pre`, else `latest`. Two consecutive releases, a re-run and a fresh install by `@alpha` are in evidence section 4, B; a test runs the real step with stubs for `devenv` and `npm` (tag in and out of pre mode, skip, stop at first failure, no `changeset publish`). `latest`: **not managed.** The registry sets `latest` itself on a package's first publish (the local registry did; npm's behaviour is not observed), and nothing here moves it, so after the first publish `latest` may point at `0.1.0-alpha.0` and stay there. Intended state is no `latest` until a stable release; the operator reads `dist-tags` after the first publish (the `check` mode prints them) and decides whether to remove it.
  6. **The token and mode gates are narrowed in text and tightened in code.** Controls found that the code was weaker than the F-rel7 and F-rel8 text. Now: a job may read the token in **one** step (a second fails); the print rule adds `export`, `declare -x/-p`, `typeset`, a bare `set`, `compgen -e`, `/proc/*/environ` and `process.env`, and `env` after `;`, `&&` or `|` (it stays a deny-list of common printers, not a proof that nothing can print the token: the spec says so); a bare `--dry-run` is a dry run, `--dry-run=false`, `--dry-run false`, `--no-dry-run` are not; shell comments are removed before the commands are read (quote-aware), so `# --dry-run` excuses nothing. Controls on the real file are in evidence section 6, V1 to V6.
  7. **Library ranges are carets.** A shipped `catalog:` dependency was the catalog's exact pin (`pg` 8.23.1, `zod` 4.6.7, `libpg-query` 18.2.1, `oxc-parser` 0.153.0). A consumer on another `pg` or `zod` would get a second copy. Now `^<catalog version>` (a catalog entry that already has a range keeps it); the lockstep `@pg-txmode/*` dependencies stay exact. The workspace catalog still pins what this repository tests.
  8. **`bin` ships as `cli.mjs`, not `./cli.mjs`.** `npm publish ./dist` printed `npm warn publish "bin[pg-txmode-lint]" script name cli.mjs was invalid and removed` for the `./` form (the tarball kept the bin; the registry document had it normalised). The generated manifest now uses npm's own form and the warning is gone.
  9. **The `check` job also prints `dist-tags`** of each package (public reads) and its tag follows the `Publish` step's rule.
- **2026-10-30, after the merge of PR #11 (issue #12, lows 1 and 2; the version PR).**
  10. **No claim about `latest` that was not observed.** Revisions 5 said the intended state is no `latest` until a stable release. On Verdaccio, removing `latest` re-created it on the newest alpha; npm's behaviour is not observed (`npm view @pg-txmode/core` is E404 today: nothing exists to observe). Read: after the first publish the operator runs `npm view @pg-txmode/<name> dist-tags` (the `check` mode prints the same) and decides; until then an untagged install, `npm i @pg-txmode/core`, may get `0.1.0-alpha.0` (not the newest alpha), and `@alpha` always gets the newest. The README says so.
  11. **The `Publish` step prints what `npm view` says and publishes only on E404.** It used to treat every `npm view` failure as "not on the registry". Now: success = skipped; output with `E404` = publish; anything else (network, registry error, 5xx) prints the output and stops with nothing published for that package. Real npm answers E404 for a missing package and for a missing version of an existing one (`npm view zod@9.9.9 version` and `npm view @pg-txmode/nonexistent-xyz@1.0.0 version`, both exit 1, evidence section 7). Tests (stubs): a non-E404 error stops and prints it; a refused name (E403 on `effect` after `core`) stops the set, and a re-run skips `core` and publishes `effect`, `lint`, `pg`.
  12. **The version commit** (`changeset version`): `0.1.0-alpha.0` for the four packages, a `CHANGELOG.md` each, `.changeset/pre.json` lists the consumed changeset. No publish; the hold stays.
- **2026-10-30, the release hold is lifted (operator decision, relayed by the lead).**
  13. **`.github/release-hold` is deleted** by this PR (spec 0006 "Lifting"; Revisions 12 left it in force). Nothing else changes: the `Release hold` step stays in `publish` as a mechanism (the hold gate and its controls are unchanged; the test does not require the file to exist, so a hold can be put back by adding the file). After the merge a dispatch of `mode=publish` on `main` can publish; it still waits for the environment `npm-release` approval of its reviewer (`phibkro`), and the `checks` check-run of the commit must be `success`. The first publish creates the four names `@pg-txmode/{core,pg,effect,lint}` at `0.1.0-alpha.0` under `alpha` and is permanent. **Afterwards** the operator reads `npm view @pg-txmode/<name> dist-tags` for each package (Revisions 10). The token path is unchanged.
- **2026-10-30, the harness joins the published set** ([spec 0007](0007-harness-publish.md), operator decision relayed by the lead). The "harness: no" row above is superseded; everything else here applies to it unchanged (`release:stage`, the `Publish` step, the token path).
- **2026-10-30, the first publish is observed (review of PR #15).** `npm view @pg-txmode/<name> dist-tags` on the real registry for core, pg, effect and lint: `{latest: 0.1.0-alpha.0, alpha: 0.1.0-alpha.0}`. So **npm sets `latest` on the first publish of a package even with `--tag alpha`**; Revisions 10's "npm's behaviour is not observed" is now answered for the first publish. What a later publish with `--tag alpha` does to `latest` on npm is still observed only on the local registry (it stays).
- **2026-10-30, correction and two changes (issue #12; [spec 0008](0008-harness-hardening.md)).** (a) Revisions 12 said `.changeset/pre.json` lists the consumed changeset: it does not (`pre.json` holds `{mode, tag}`; the consumed file moves to `.changeset/pre/<name>.md`). (b) The `Publish` step publishes only when `npm view` prints a line starting `npm error code E404` (it matched `E404` anywhere in the output). (c) A gate (`engineFindings`) requires the `devEngines` removal before any publishing step.

- **2026-10-30, spec 0010 supersedes the token removal checklist.** Trusted publishing has succeeded for all five packages. The check job and mode input remain because the unauthenticated dry run checks release artifacts; `secretspec.toml` remains as an empty profile. The check job no longer uses the environment or checks a token. The publish job retains `npm-release` and OIDC. Follow the ordered operator procedure in [spec 0010](0010-oidc-token-removal.md), including the first watched token-free publish, secret deletion, token revocation, and disabling token publishing per package.
