# 0008 Harden the harness cleanup and close the release lows

Status: **spec** (frozen when its PR opens). Date: 2026-10-30. Decided by: the lead (relayed 2026-10-30): the lows of issue #12 that change code are fixed before the next version, which is the one that validates npm's trusted publishers.
Process: [spec 0000](0000-development-lifecycle.md). Based on `main` (specs 0000 to 0007 merged; `0.1.0-alpha.1` of the five packages published). Builds on [spec 0006](0006-release.md) and [spec 0007](0007-harness-publish.md).
Verify skill: `verify-pg-txmode` (unchanged: its harness row already names the stage and the dry run; the new tests run under `ready`).

## Problem

Reviews of PRs #13, #15 and #16 left lows that are open on issue #12 and that a consumer or the next release can hit:

1. **The harness watchdog can fail silently or crash the host.** `run()` spawns `sh` for each server with no `error` listener: a missing `sh` is an unhandled `error` event that crashes the host process and orphans the server it was to guard. With `sh` present but `sleep` absent, the loop `sleep 1` fails at once and spins (about 45% of a core per server).
2. **The orphan test can leave servers running when it fails** (its failing control did, four times).
3. **The `Publish` step's `E404` match is a substring of the whole output** (`grep -q "E404"`): an error of another code whose body contains `E404` (for example `npm error code E500 ... upstream said "E404 Not Found"`) would be read as "not on the registry" and would publish. (This text first said `E502 ... 404`, which the old line did not match: see Revisions.)
4. **The `devEngines` removal is ungated**: deleting it passes every test and fails only on the first release runner.
5. **Evidence is stale or missing**: tarball figures of the harness evidence; the local-registry rehearsal of the E404 branch, of a refused name and of an unreachable registry; spec 0006 Revisions 12 says `pre.json` lists the consumed changeset (it does not).

## Goal

No server is left behind by any failure of the watchdog itself; the failing orphan control cleans up after itself; the E404 match is a line anchored to npm's own error line; the `devEngines` step is gated; the evidence is current. Nothing is published and no version changes in this PR (the version PR for `0.1.0-alpha.2` follows).

## Journey

```sh
git checkout feat/0008-harness-hardening
cd packages/harness && devenv shell -- bunx vp test run test/watchdog.test.ts test/orphans.test.ts
cd ../../tools/quality && devenv shell -- bunx vp test run test/releaseWorkflow.test.ts
```

Raw output and the controls: [`docs/evidence/harness-hardening/README.md`](../evidence/harness-hardening/README.md).

## Decisions

| Item | Decision | Why |
| --- | --- | --- |
| Watchdog cannot start (`error` event: no `sh`) | the server is killed, the output gets "the cleanup watchdog (sh) could not run: sh: <cause>; the server was killed", and the start fails through the existing "exited early" path with that output | a server with no cleanup guarantee is the orphan the watchdog exists to prevent; failing the start is the only honest outcome |
| `sleep` or `rm` missing | the first line of the watchdog script exits 127 when either is absent; the `exit` handler treats 127 like the `error` case ("sleep or rm is not on PATH") | the loop would otherwise spin; `kill` is a shell builtin and needs no check |
| `waitUntilAccepting` | also stops when the server ended by a signal (`signalCode`): a killed server has `exitCode` null, which the old check read as "still running" | otherwise the SIGKILL above would be waited on for 10 s |
| Orphan test cleanup | in `finally`, every process whose command line names the test's scratch directory is ended by pid (read from `/proc`), before the directory is removed | only that test's own processes; no pattern kill of anything else |
| `E404` | `grep -q "^npm error code E404"` on the output, one line anchored at its start | npm prints `npm error code E404` as the first line of a 404; a gateway error prints its own code line |
| `devEngines` gate | `engineFindings` (`releaseWorkflow.ts`): a job with a publish command (not a dry run) must have a step before it whose script has `del(.devEngines)` | one rule, the same shape as the hold gate; the check job is a dry run from outside the checkout and needs none |
| Evidence | one new file (`docs/evidence/harness-hardening`) with the rehearsals and controls; the harness-publish figures are replaced with measured ones | |
| Not done | no change to the publish order (spec 0007 Revisions 3 records it); no Windows support (the watchdog is POSIX `sh`) | |

## Falsifiers

| # | Falsifier | Gate | Control |
| --- | --- | --- | --- |
| F-8.1 | With no `sh` on `PATH`, the start fails, the server is killed and the output names `sh` | `watchdog.test.ts` | the `error` listener renamed: the test times out (the server lives) |
| F-8.2 | With `sh` but no `sleep` or `rm`, the server is killed at once and the output says so | `watchdog.test.ts` | the guard line replaced by `true`: the test times out |
| F-8.3 | With `sh`, `sleep` and `rm` the server runs (no false refusal) | `watchdog.test.ts` | n/a |
| F-8.4 | A failing orphan test leaves no process whose command line names its scratch directory | `orphans.test.ts` | the watchdog spawn disabled: all three tests fail and `ps` shows none left (0) |
| F-8.5 | Only a line `npm error code E404` publishes; an error whose body contains `E404` outside that line stops the step | `releaseWorkflow.test.ts` (real step, stubs) | the exact previous line `grep -q "E404"` on the real file: the control fails |
| F-8.6 | A job that publishes has a `devEngines` removal before it | `releaseWorkflow.test.ts` (fixtures and the real file) | `del(.devEngines)` renamed on the real file: the test fails |
| F-8.8 | A server killed by a signal fails the start at once (not after 200 attempts of 50 ms) | `watchdog.test.ts` (bound 5 s) | the `|| signalCode !== null` removed: the test fails |
| F-8.7 | The real `Publish` step against a registry: publish on E404, skip on success, stop on E403, stop and print on a non-E404 error | evidence section 1 (local Verdaccio; not a gate) | refused name, unreachable registry |

## Constraints and values

No Effect; no secret; no publish by an agent; the harness API (`index.ts`) does not change (`run` and `Running` are exported from `stack.ts` for the test only). Not claimed: that npm's behaviour for the rehearsed errors equals Verdaccio's (the real-registry E404 text was read, spec 0006 evidence section 7), non-Linux platforms.

## Revisions

- **2026-10-30, plan written** with the build.
- **2026-10-30, found while building.**
  1. **`npm view` can answer from its cache when the registry is gone.** With the local registry stopped, the real `Publish` step said "is on the registry: skipped" for the versions that had been viewed before (npm served the cached packument), then hung on a version it had not. A runner starts with an empty cache, so the release is not affected; the rehearsal of the non-E404 branch therefore uses an empty cache and `NPM_CONFIG_FETCH_RETRIES=0` (evidence section 1, R5). Not changed.
  2. **The watchdog tests leave stub servers when they fail**, which is the defect they test for; `afterEach` now ends every stub it started.
- **2026-10-30, corrections to earlier specs (issue #12).** Spec 0006 Revisions 12 said `.changeset/pre.json` lists the consumed changeset. It does not: `pre.json` holds only `{mode, tag}` (read on main after two version commits); the consumed file moves to `.changeset/pre/<name>.md`. Corrected by a dated line in spec 0006.
- **2026-10-30, after review round 1 of PR #17 (recorded by `RevPgTx3` at `e6200b8`).**
  3. **F-8.5 could not fail on the line it replaced (medium).** The old line was `grep -q "E404"`; the first fixture (`E502 ... upstream said 404`) contains no `E404`, so the old line passed it, and the control (`grep -q "404"`) restored code that never existed. Problem 3 described a hole that was not there. The real hole is a non-404 error whose body contains `E404`. The fixture is now `npm error code E500 ... upstream said "E404 Not Found"`; with the exact old line on the real file the control fails; Problem 3 and F-8.5 are corrected in place and say so.
  4. **F-8.8 (new):** the `signalCode` check of `waitUntilAccepting` had no falsifier. `watchdog.test.ts` starts a stub that kills itself with SIGKILL and requires the wait to reject within 5 s ("exited early"); without the check it takes 10 s.
  5. **The devEngines gate is stricter and its test builds its cases:** the step must run `jq ... del(.devEngines)` with no `if`; fixtures for the removal after the publish, as an `echo`, and under `if: false` fail. Limit stated: the gate reads the workflow text; it does not prove the step runs on the runner (a `run` that exits early, a different file).
  6. **The orphan test ends its parent explicitly** in `finally` (its command line does not name the scratch directory).
