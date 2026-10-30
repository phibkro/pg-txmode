# Provenance

The development lifecycle (spec 0000) is copied from [`reebeat/studio`](https://github.com/reebeat/studio) at commit `d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8` (`main`, 2026-10-29; "studio"). Studio copied it from [`reebeat/reebeat`](https://github.com/reebeat/reebeat) at `f7c348877585f54b6bf00651608726dd7e5044d3`, which adapted most of it from [`phibkro/vektorprogrammet-reimagined`](https://github.com/phibkro/vektorprogrammet-reimagined) at `797e9e41d96194b9479ff224ac1c40bbc0545888` and `1104c3019a76c619c4c8e9ee04c71ce191467ed4` (the donor); the headers that name them were kept. Third-party licences stay with their code.

**Identical** means the file's git blob hash equals studio's, checked with `git hash-object <file>` against `git rev-parse d4fd75e:<file>` in a studio checkout. The nine files of the first rows matched on 2026-10-29; `tools/quality/tsconfig.json` and `tools/quality/vite.config.ts` (eleven in all) were added to the set after review round 1, and also match.

| File | Source (studio `d4fd75e`) | Deviation |
| --- | --- | --- |
| `.vite-hooks/pre-commit`, `commit-msg`, `pre-push` | same paths | identical |
| `commitlint.config.ts`, `devenv.yaml`, `devenv.lock`, `CLAUDE.md` | same paths | identical |
| `.agents/skills/review-pr/merge.sh`, `record-round.sh` | same paths | identical (`record-round.sh` carries the Author/Reviewers/Checked rule and the refusal of a pass that the author recorded) |
| `.agents/skills/review-pr/SKILL.md`, `reviewers.md` | same paths | adapted: the Foldkit checks and the browser rule are dropped; `verify-pg-txmode`; public-repository check for `LICENSE` and `NOTICE`; a section "Round without spawned reviewers" |
| `.agents/skills/pr-create/SKILL.md` | same path | adapted: the repository's names; the vocabulary points at the README and the catalogue; the verify skill |
| `.agents/skills/verify-pg-txmode/scripts/headroom.sh` | `.agents/skills/verify-studio/scripts/headroom.sh` | adapted: the header (names and provenance) and `DEMAND_MEM_MIB` (3584 to 3072: no Chromium, but PostgreSQL and PgBouncer); `DEMAND_DISK_MIB` (512) is unchanged; the four limits and the fail-closed rule are studio's |
| `.agents/skills/verify-pg-txmode/scripts/lib.sh` | `.agents/skills/verify-studio/scripts/lib.sh` | reduced to `TREE`, `EVIDENCE_ROOT`, `die` and `in_devenv`; evidence root `~/.local/state/pg-txmode-verify` |
| `.agents/skills/verify-pg-txmode/SKILL.md` | `.agents/skills/verify-studio/SKILL.md` (shape only) | new text: headroom, gates, path table, cleanup |
| `.github/workflows/checks.yml` | same path | identical commands and pins; two step names changed (no Effect, no editor here); one step added (`README table`, `check:docs`); the header is new |
| `package.json` | same path | name, workspaces (`packages/*`, `tools/*`), scripts (`check:exceptions` runs `checkExceptions.ts`), `catalog` cut to what this repository uses (no Foldkit, Tailwind); since spec 0003 the catalog lists the Effect packages of `packages/effect` |
| `vite.config.ts` | same path | no Foldkit or vendored anti-slop Effect rules; restricted-import patterns renamed `@pg-txmode/`; since spec 0003 the Oxlint Effect plugin (no `@effect/tsgo` preset: `vp check` would run them for nothing, spec 0003 Revisions), scoped to `packages/effect/**` (reebeat's `vite.config.ts` @ `82ee66f`, one group instead of its package list) |
| `tsconfig.json` | same path | no Effect language-service plugin; `include` lists the root files and `tools/`; `target` and `lib` `es2024` added in spec 0001 (`Promise.withResolvers`) |
| `tools/quality/tsconfig.json`, `tools/quality/vite.config.ts` | same paths | identical |
| `.gitleaks.toml` | same path | the title |
| `.jscpd.json`, `knip.json` | same paths | `.jscpd.json` without the anti-slop ignore; `knip.json` rewritten for `tools/quality`, and since spec 0003 a workspace `packages/effect` that lists its two entry scripts and ignores the dependency `@effect/language-service` (named only by the `plugins` entry of that package's `tsconfig.json`, which the compiler reads and knip does not) |
| `devenv.nix` | same path | adds `postgresql_18` and `pgbouncer` (the servers of the harness of spec 0001); no Chromium, ffmpeg or whisper. The `stack` process (`devenv up`) arrives with its script in spec 0001 |
| `AGENTS.md` | same path | gates, stack and emergency command rewritten for this repository; no Foldkit or Effect sections |
| `docs/specs/0000-development-lifecycle.md` | studio's spec 0000 | rewritten: it records what is the same, what differs and why |
| `tools/quality/exceptions.ts`, `checkExceptions.ts`, `exceptions.json`, `test/exceptions.test.ts` | `tools/quality/effectExceptions.ts`, `checkEffectExceptions.ts`, `effect-exceptions.json`, `test/effectExceptions.test.ts` | **ported to plain TypeScript** (node:fs, zod): the pg-txmode core and its tooling do not depend on Effect; same checks, same findings, same controls; one added control (a registry entry that lacks a field) |
| `tools/quality/test/recordRound.test.ts`, `headroom.test.ts`, `scriptHarness.ts` | same paths | **ported to plain Vitest** (node:child_process): the same samples, controls and assertions |
| `tools/quality/test/effectBoundary.test.ts` | none | original |

## Added by spec 0001

| File | Source | Deviation |
| --- | --- | --- |
| `docs/evidence/hyperdrive/vektorprogrammet-reimagined-0000-results.md` | [`phibkro/vektorprogrammet-reimagined`](https://github.com/phibkro/vektorprogrammet-reimagined) `docs/specs/0000-results.md` @ `1104c3019a76c619c4c8e9ee04c71ce191467ed4` (public, the operator's) | an excerpt: the final run's check lines and the comparison table of check 3b, copied without change; identifiers left out |
| `packages/harness/src/profile.ts` | Neon's published PgBouncer configuration, <https://neon.com/docs/connect/connection-pooling> (read 2026-10-29) | the five settings that the page lists; `max_client_conn` is lowered to fit the open-file limit when that is lower (PgBouncer refuses to start otherwise) |
| `tools/quality/*`, `packages/*` (everything else of spec 0001) | none | original; the research report `REPORT.md` of 2026-10-29 (HyperdriveResearch-2) is the source of the facts, cited per catalogue row |

## Third-party packages used by spec 0001 (installed, not copied)

| Package | Licence | Used for |
| --- | --- | --- |
| `libpg-query` 18.2.1 (`constructive-io/libpg-query-node`; the PostgreSQL 18 parser from `pganalyze/libpg_query`, compiled to WebAssembly) | MIT (the npm package); BSD-3-Clause (the C library it builds on, per the research report) | the AST of the lint |
| `oxc-parser` 0.153.0 | MIT | `sql` tagged templates of the lint; the exception registry check |
| `pg` (node-postgres) 8.23.1 | MIT | the harness's driver (a development tool; the core does not import it) |
| `zod` 4.6.7 | MIT | the shape of the registry and of the statement log |

## Third-party packages used by spec 0003 (installed, not copied)

| Package | Licence | Used for |
| --- | --- | --- |
| `effect` 4.1.0, `@effect/sql-pg` 4.1.0 (`Effect-TS/effect`) | MIT | the Effect adapter's runtime dependencies (`packages/effect`); no other package depends on them |
| `@effect/vitest` 4.1.0, `@effect/platform-node` 4.1.0 | MIT | the adapter's tests (`it.effect`, `layer`; the child-process layer that runs a hung client in a process of its own) |
| `@effect/tsgo` 0.63.0 | MIT | the Effect language-service diagnostics and the Oxlint `effecttsgo/*` rules, for `packages/effect` only; the one Effect package the repository root may list |
| `@phibkro/oxlint-effect-plugin` 0.2.0 | MIT | the Oxlint Effect rules (roles per path), for `packages/effect` only |

`packages/effect/tsconfig.json` carries reebeat's list of Effect language-service diagnostics (all at `error`, `reebeat/reebeat` @ `82ee66f` `tsconfig.json`) with its own `allowedUnstableApis`: the modules the adapter uses, which spec 0003 names.

## Added by spec 0006 (npm release)

Source: [`tsukuri-labs/tsukuri`](https://github.com/tsukuri-labs/tsukuri) (the reebeat repository; Apache-2.0, read with `gh api repos/tsukuri-labs/tsukuri --jq .license.spdx_id`) spec 0009, PR #29, merge commit `d0c5a1de330200302edbad58784f351b09eeb4f8`, read 2026-10-30.

| File | Source (tsukuri `d0c5a1d`) | Deviation |
| --- | --- | --- |
| `.github/workflows/release.yml` | same path | package names and scope; the `check` job gains a checkout, the stage step, a `--dry-run` publish of each package (tsukuri's `check` needs none) and a `dist-tags` read; the `publish` job does **not** call `changeset publish` (it tags a second alpha `latest`; spec 0006, Revisions 5): its `Publish` step runs `npm publish ./<dist> --tag <pre-mode tag>` per package and skips what the registry has; the hold text and the pins are the same |
| `.github/release-hold` | same path | the reason (the first publish is the operator's decision; tsukuri's was a name clearance) |
| `secretspec.toml` | same path | project name retained; the token declaration was removed in spec 0010 |
| `tools/quality/releaseWorkflow.ts`, `test/releaseWorkflow.test.ts` | `tools/quality/releaseWorkflow.ts`, `tools/quality/test/releaseWorkflow.test.ts` | **ported to plain TypeScript** (`zod`, `yaml`; Vitest); spec 0010 replaces the token rule with a token-free guard; a publish command with `--dry-run` is not a publish, a script is split at `;`, `&&`, `\|\|` and `\|`, with controls for both |
| `tools/quality/release.ts`, `stagePackages.ts` | none: **original**. The design (publishConfig `directory: dist`, a generated manifest, an `npm pack --dry-run --json` allowlist, `workspace:`/`catalog:` rewriting) follows the decisions of tsukuri's spec 0009, which was read; its stage script and `release.ts` were not | `exports` map to a flat `dist`; `bin` is built; one added rule (`importFindings`: a built file may import only what the manifest ships, and declarations need shipped types) found a real defect (spec 0006, Revisions 1) |
| `tools/quality/test/release.test.ts` | `tools/quality/test/release.test.ts` (read; not copied) | rewritten in plain Vitest for this repository's rules; the same shape (a rule, a control, then the real manifests) |
| `.changeset/config.json`, `README.md` | `changeset init` of `@changesets/cli` 3.0.3 | one `fixed` group of four packages; `commit: false`; `privatePackages`; `access: public` |
| `.changeset/pre.json` | `changeset pre enter alpha` | none |

| Package | Licence | Used for |
| --- | --- | --- |
| `@changesets/cli` 3.0.3 | MIT | versioning (`changeset version`; root, build time; the published packages do not depend on it) |
| `yaml` 2.9.1 | ISC | parsing the workflow files in the release rules (`tools/quality`) |
| `smol-toml` 1.9.1 | BSD-3-Clause | formerly used by the release rules; spec 0010 removed the direct dependency. It remains transitive through `knip` |

Licences read from the registry on 2026-10-30 (`npm view yaml@2.9.1 license`: ISC; `@changesets/cli@3.0.3`: MIT; `smol-toml@1.9.1`: BSD-3-Clause).

Not copied from studio: `apps/editor`, `tools/oxlint/anti-slop/**`, `tools/quality/effectFamily.ts`, `diagnosticRules.ts`, `featureMap.ts`, `foldkitLint.ts` and their tests, `docs/design`, `STATE.md` (rewritten), the `verify-studio` launch, doctor, cleanup and page scripts.

## Third-party licence texts

`LICENSE` is the Apache License 2.0, verbatim from <https://www.apache.org/licenses/LICENSE-2.0.txt> (SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, 2026-10-29). `NOTICE` names the copyright holder.
