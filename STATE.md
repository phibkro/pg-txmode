# State

Lifecycle: build

Now:

pg-txmode is a library for safe PostgreSQL through transaction-pooling proxies (Hyperdrive first). Spec 0000 (development lifecycle and scaffold) is in review. Spec 0001 (the core: catalogue, connection mode, safe SQL constructs, harness, SQL lint) is stacked on it, and spec 0002 (the `pg` adapter) on that.

Next:

- Review spec 0000, then merge it with `merge.sh` once a round passes; retarget the stacked PR of spec 0001 to `main`, and so on up the stack.
- Later specs (README roadmap, planned only): postgres.js; `@effect/sql-pg` with Drizzle `effect-postgres` and `SqlModel` (the only package that may depend on Effect); the deployed Hyperdrive probe Worker.

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its wizard steps are written in spec 0001's PR; nothing is run.
