# Harness hardening evidence (spec 0008)

Measured 2026-10-30 on `feat/0008-harness-hardening`, Node 24.21.0, npm 11.19.0, Verdaccio 6.11.1, inside `devenv shell`. Nothing touched the npm registry except read-only `npm view` (spec 0006 evidence section 7).

## 1. The real `Publish` step against a local registry (F-8.7)

The step's `run` text is read from `.github/workflows/release.yml` with the `yaml` package into `/tmp/publish-step.sh` and run as it is, in a copy of the tree (`/tmp/pgtx-rh`: `devEngines` removed by `jq 'del(.devEngines)'` as the workflow's step does; `release:stage` run; versions `0.1.0-alpha.1`). A throwaway user per phase; its token (96 to 116 characters) is in `NODE_AUTH_TOKEN`, never printed; `NPM_CONFIG_USERCONFIG` holds `//127.0.0.1:4873/:_authToken=${NODE_AUTH_TOKEN}`.

Registry config: `@pg-txmode/effect` has `publish: nobody` (refused) in phases R1 and R2, `$authenticated` in R3 and R4; no uplink (a missing package is a local 404).

```text
=== R1: fresh registry, effect refused (E403)
@pg-txmode/core@0.1.0-alpha.1 is not on the registry: publishing
+ @pg-txmode/core@0.1.0-alpha.1
@pg-txmode/effect@0.1.0-alpha.1 is not on the registry: publishing
npm error code E403
npm error 403 403 Forbidden - PUT http://127.0.0.1:4873/@pg-txmode%2feffect - user rehearsal is not allowed to publish package @pg-txmode/effect
exit 1
registry afterwards:  core ["0.1.0-alpha.1"]   effect [] harness [] lint [] pg []

=== R2: re-run, effect still refused: core skipped, the set stops again
@pg-txmode/core@0.1.0-alpha.1 is on the registry: skipped
@pg-txmode/effect@0.1.0-alpha.1 is not on the registry: publishing
npm error code E403
npm error 403 403 Forbidden - PUT http://127.0.0.1:4873/@pg-txmode%2feffect - user r2 is not allowed to publish package @pg-txmode/effect
exit 1

=== R3: effect allowed (config changed, registry restarted): core skipped, the rest published
@pg-txmode/core@0.1.0-alpha.1 is on the registry: skipped
@pg-txmode/effect@0.1.0-alpha.1 is not on the registry: publishing
+ @pg-txmode/effect@0.1.0-alpha.1
@pg-txmode/harness@0.1.0-alpha.1 is not on the registry: publishing
+ @pg-txmode/harness@0.1.0-alpha.1
@pg-txmode/lint@0.1.0-alpha.1 is not on the registry: publishing
+ @pg-txmode/lint@0.1.0-alpha.1
@pg-txmode/pg@0.1.0-alpha.1 is not on the registry: publishing
+ @pg-txmode/pg@0.1.0-alpha.1
exit 0

=== R4: complete set: all five skipped
exit 0
dist-tags, all five: {"latest":"0.1.0-alpha.1","alpha":"0.1.0-alpha.1"}   (Verdaccio sets latest on a first publish)

=== R5: registry stopped, empty npm cache (NPM_CONFIG_CACHE), NPM_CONFIG_FETCH_RETRIES=0: a non-E404 error
npm view @pg-txmode/core@0.1.0-alpha.1 failed, not E404; nothing is published for it:
npm error code ECONNREFUSED
npm error syscall connect
npm error errno ECONNREFUSED
npm error FetchError: request to http://127.0.0.1:4873/@pg-txmode%2fcore failed, reason: connect ECONNREFUSED 127.0.0.1:4873
exit 1
```

The E404 branch (publish) is R1's first line and R3's. **Found:** the first attempt at R5, with the registry stopped and the user's own npm cache, printed `is on the registry: skipped` for the two versions the cache held and then hung: `npm view` answers from its cache when the registry is unreachable (spec 0008 Revisions 1). A runner has an empty cache.

## 2. Controls (real files, restored after each)

`cd tools/quality && bunx vp test run test/releaseWorkflow.test.ts` (35 tests at baseline):

```text
D1 `del(.devEngines)` renamed in release.yml      FAIL the devEngines removal > the real workflow removes devEngines before it publishes ...   (1 failed | 34 passed)
D2 the E404 match put back to grep -q "404"        FAIL the publish step > a gateway error that mentions 404 is not an E404 (control)         (1 failed | 34 passed)
restored                                           Tests  35 passed (35)
```

`cd packages/harness && bunx vp test run <file>`:

```text
W1 the watchdog's guard line replaced by `true`    FAIL watchdog.test.ts > sh without sleep or rm: ... no spinning loop   (Test timed out in 20000ms: the server lives)   (1 failed | 2 passed)
W2 the `error` listener renamed                    FAIL watchdog.test.ts > no sh: the server is killed and the output names sh   (Test timed out in 20000ms)   (1 failed | 2 passed)
O1 the watchdog spawn disabled (orphans.test.ts)   FAIL SIGKILL / SIGTERM / SIGINT leaves no server and no directory behind   (3 failed)
   afterwards: ps -eo pid,args | grep pg-txmode-orphans- | wc -l  ->  0
```

Before the `finally` cleanup the same control left four processes (spec 0007 evidence). The two W controls left a stub Node process each, which is why `watchdog.test.ts` now ends every server it starts in `afterEach`; the one that remained from that run was ended by its pid.

Baseline: `watchdog.test.ts` 3 passed (no `sh`; `sh` only; `sh`, `sleep` and `rm`), `orphans.test.ts` 3 passed.

## 3. The tarball of the harness, after the change

`bun run release:stage`, then `cd /tmp && npm publish <worktree>/packages/harness/dist --dry-run --tag alpha --access public` (no `npm warn`):

```text
CHANGELOG.md 385B  LICENSE 11.4kB  NOTICE 127B  README.md 4.2kB  cli.d.mts 9B  cli.mjs 2.3kB  index.d.mts 8.2kB  index.mjs 1.9kB  matrix-D053EUrv.mjs 42.9kB  package.json 886B
package size: 22.3 kB   unpacked size: 72.1 kB   total files: 10
```

The figures of the version PR (`0.1.0-alpha.2`) are measured there.
