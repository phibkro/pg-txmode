# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Specs 0000 to 0006 are merged (lifecycle, core, `pg` adapter, Effect adapter, outbox lease, the `PersistedQueue` evidence, the npm release path). `@pg-txmode/{core,pg,effect,lint}@0.1.0-alpha.0` are published under `alpha`. Spec 0007 (the harness as a published, documented test tool) is in review.

Next:

- Spec 0007 (this PR) publishes the harness too; then the version PR (all five at `0.1.0-alpha.1`) and the operator's `mode=publish`; then read `npm view @pg-txmode/<name> dist-tags` for the five.
- Later: trusted publishing and the removal checklist of spec 0006; the specs of the README roadmap (postgres.js; Drizzle `effect-postgres` and `SqlModel` on the Effect adapter; the deployed Hyperdrive probe Worker).

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
