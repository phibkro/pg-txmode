# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Spec 0000 (development lifecycle and scaffold) and spec 0001 (the core: catalogue, connection mode, safe SQL constructs, harness, SQL lint) are in review, stacked; spec 0002 (the `pg` adapter) is stacked on 0001.

Next:

- Review spec 0000, then merge it with `merge.sh` once a round passes; retarget the stacked PR of spec 0001 to `main`, and so on up the stack.
- Later specs (README roadmap, planned only): postgres.js; `@effect/sql-pg` with Drizzle `effect-postgres` and `SqlModel` (the only package that may depend on Effect; it also reproduces the M2b hang); the deployed Hyperdrive probe Worker.

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
