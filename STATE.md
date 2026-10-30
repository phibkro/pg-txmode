# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Specs 0000 (development lifecycle and scaffold), 0001 (the core: catalogue, connection mode, safe SQL constructs, harness, SQL lint), 0002 (the `pg` adapter), 0003 (the Effect adapter) and 0004 (the outbox delivers at least once: lease, token, fence) are merged, and so is the evidence of spec 0005 (`PersistedQueue` behind PgBouncer). Spec 0006 (the npm release path) is merged, the version commit (`0.1.0-alpha.0`) is merged, and the release hold is lifted by the PR that deletes `.github/release-hold`. Nothing is published yet.

Next:

- The operator dispatches Release with `mode=publish` (environment approval); the four packages appear at `0.1.0-alpha.0` under `alpha`. Then read `npm view @pg-txmode/<name> dist-tags` for each.
- Later: trusted publishing and the removal checklist of spec 0006; the specs of the README roadmap (postgres.js; Drizzle `effect-postgres` and `SqlModel` on the Effect adapter; the deployed Hyperdrive probe Worker).

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
