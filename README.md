# pg-txmode

Safe PostgreSQL through **transaction-pooling proxies**: Cloudflare Hyperdrive first, with PgBouncer in transaction mode and Supavisor as the same class of proxy.

A transaction pooler hands your next statement to whichever server connection is free. Anything that lives in a *session* (`SET`, session advisory locks, `LISTEN`, named prepared statements, `WITH HOLD` cursors, `PRESERVE ROWS` temporary tables) then belongs to nobody, and nothing reports the mistake. pg-txmode makes those facts explicit, testable and hard to get wrong:

- a **catalogue** of where a pooled connection differs from a direct PostgreSQL connection, as one data file with a source and a way of verifying for every row;
- a **typed connection mode** with a capability record, so a client built for a pooled mode has no session-only API;
- **safe SQL constructs** (row locks, `ON CONFLICT` claims, conditional `UPDATE`, outbox, `SET LOCAL`, isolation levels, whole-transaction retry, per-transaction timeouts), each with an executable test against PgBouncer;
- a **harness** that starts PostgreSQL and PgBouncer and runs a probe suite, so a session-state leak fails a test instead of production;
- a **SQL lint** on the PostgreSQL parser's own AST, over source files and over a recorded statement log.

The core has no dependency on Effect or on any one driver. Adapters are thin.

Status: in development. The first specs are in review; nothing is published to npm yet.

## Roadmap

Planned only; nothing below is built.

1. Spec 0000: development lifecycle and scaffold.
2. Spec 0001: the core (catalogue, connection mode, constructs, harness, lint).
3. Spec 0002: the `pg` (node-postgres) adapter.
4. postgres.js adapter.
5. `@effect/sql-pg`, Drizzle `effect-postgres` and Effect `SqlModel` adapter (the only package that depends on Effect).
6. A deployed Hyperdrive probe Worker, the only source of Hyperdrive truth. It needs Cloudflare credentials, so it is a human-run wizard.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
