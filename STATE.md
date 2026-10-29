# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Specs 0000 (development lifecycle and scaffold), 0001 (the core: catalogue, connection mode, safe SQL constructs, harness, SQL lint) and 0002 (the `pg` adapter) are merged. Spec 0003 (`packages/effect`, the Effect adapter on `@effect/sql-pg`) is in review.

Next:

- Review spec 0003 and merge it with `merge.sh` once a round passes.
- Later specs (README roadmap, planned only): postgres.js; Drizzle `effect-postgres` and `SqlModel` on the Effect adapter; the deployed Hyperdrive probe Worker.

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
