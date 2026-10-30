# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Specs 0000 (development lifecycle and scaffold), 0001 (the core: catalogue, connection mode, safe SQL constructs, harness, SQL lint), 0002 (the `pg` adapter), 0003 (the Effect adapter) and 0004 (the outbox delivers at least once: lease, token, fence) are merged, and so is the evidence of spec 0005 (`PersistedQueue` behind PgBouncer). Spec 0006 (the npm release path: stage step, Changesets pre mode `alpha`, the Release workflow, held) is in review. Nothing is published.

Next:

- Review spec 0006 and merge it with `merge.sh` once a round passes.
- Then, in this order (spec 0006, "Operator steps"): the version PR (`0.1.0-alpha.0`); the operator dispatches Release with `mode=check` and the result is read; a PR that deletes `.github/release-hold`; the operator dispatches `mode=publish`.
- Later specs (README roadmap, planned only): postgres.js; Drizzle `effect-postgres` and `SqlModel` on the Effect adapter; the deployed Hyperdrive probe Worker.

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
