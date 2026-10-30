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
