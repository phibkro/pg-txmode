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
| `.github/workflows/checks.yml` | same path | identical commands and pins; two step names changed (no Effect, no editor here); the header is new |
| `package.json` | same path | name, workspaces (`packages/*`, `tools/*`), scripts (`check:exceptions` runs `checkExceptions.ts`; `prepare` without the Effect patch), `catalog` cut to what this repository uses (no Effect, Foldkit, Tailwind) |
| `vite.config.ts` | same path | no Effect, Foldkit or vendored anti-slop Effect rules; restricted-import patterns renamed `@pg-txmode/` |
| `tsconfig.json` | same path | no Effect language-service plugin; `include` lists the root files and `tools/` |
| `tools/quality/tsconfig.json`, `tools/quality/vite.config.ts` | same paths | identical |
| `.gitleaks.toml` | same path | the title |
| `.jscpd.json`, `knip.json` | same paths | `.jscpd.json` without the anti-slop ignore; `knip.json` rewritten for `tools/quality` |
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

Not copied from studio: `apps/editor`, `tools/oxlint/anti-slop/**`, `tools/quality/effectFamily.ts`, `diagnosticRules.ts`, `featureMap.ts`, `foldkitLint.ts` and their tests, `docs/design`, `STATE.md` (rewritten), the `verify-studio` launch, doctor, cleanup and page scripts.

## Third-party licence texts

`LICENSE` is the Apache License 2.0, verbatim from <https://www.apache.org/licenses/LICENSE-2.0.txt> (SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, 2026-10-29). `NOTICE` names the copyright holder.
