# 0010: Remove the npm publishing token

Status: build; frozen at PR open. Date: 2026-10-30.

## Journey

After trusted publishing was observed for all five packages in release run 41047699584, a maintainer can check release artifacts without credentials and publish a future version on main through npm trusted publishing after the `npm-release` environment approval. The operator removes the obsolete environment secret and revokes the old npm token after merge. The first publish after removal must be watched: a dry run cannot prove the OIDC exchange or registry authorization.

## Constraints and falsifiers

- No workflow reads an npm token or configures npm token authentication; tests reject reintroduction anywhere in workflow content.
- Publish retains `id-token: write`, provenance, the `npm-release` environment, its main-only guard, and the E404-only missing-version behavior. Check retains token-free dry runs and cannot publish.
- Release controls have negative fixtures for token reads and loss of OIDC authorization; existing release safety controls remain.
- Document the five-package procedure and operator cleanup, without publishing or dispatching a workflow.

## Revisions

- 2026-10-30: Initial plan, following the removal checklist in spec 0006.

- 2026-10-30, review round 1: Spec 0010 was numbered from the assignment’s reference to a separate 0009 checklist; this repository has no 0009. The lifecycle is spec 0000. The base is main at `d9b4142`. The earlier journey is amended: keep the secret until the first token-free publish succeeds, so rollback remains possible. The check job no longer needs environment approval.

  | Falsifier | Gate | Negative control |
  | --- | --- | --- |
  | A workflow reads an npm token or configures npm authentication | `releaseWorkflow.test.ts` checks all workflow files | Fixtures add secret references, auth configuration, and a literal token |
  | Publish loses OIDC, provenance, environment, main guard, hold, or E404-only behavior | `releaseWorkflow.test.ts` and the release script controls | Change each field or feed a non-E404 registry failure |
  | Check can publish or no longer dry-runs packages | `releaseWorkflow.test.ts` | Add a non-dry-run publish in check |
  | The operator cannot find the cleanup steps | Review the procedure below | Remove a step and compare against this revision |

  Operator procedure (external effects, not performed by this PR):

  1. Merge the PR. Keep the `NPM_TOKEN` secret in the `npm-release` environment for rollback. The new workflow does not read it.
  2. At the next version release, approve the `npm-release` deployment and watch the first token-free publish. Check all five packages: `core`, `pg`, `effect`, `lint`, and `harness`. A dry run does not prove OIDC authorization.
  3. After success, delete `NPM_TOKEN` from repository `phibkro/pg-txmode`, environment `npm-release`.
  4. In npm Access Tokens, identify the obsolete granular token by its creation date and scope, and revoke only that token. The candidate created at approximately 2026-10-30 01:11 UTC is inferred from the secret’s 01:13 UTC creation time; verify before revocation. Other candidates are 2026-10-29 approximately 19:53 UTC and 2026-10-30 approximately 09:25 UTC. Token names are not known.
  5. In each of the five packages’ npm publishing settings, disallow token publishing after confirming the trusted publisher. Do not change the environment approval.
