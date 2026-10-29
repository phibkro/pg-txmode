import type { Cell, Outcome, Row } from "./catalogueTypes.ts";

/**
 * The catalogue: where a pooled PostgreSQL connection is not a direct one. This file is the one source of the facts:
 * the README table is generated from it (`bun run docs:gen`, checked by `bun run check:docs`), the capability record of
 * a connection mode is computed from it, the lint messages quote it, and the harness compares every probe to it.
 *
 * The columns:
 * - `direct`: a PostgreSQL connection from the client's own socket.
 * - `transactionPooled`: PgBouncer 1.25 in transaction mode, which also stands for Supavisor and Neon's pooler where a
 *   row says so. `probe` rows were observed against the harness's PgBouncer with Neon's published settings.
 * - `hyperdrive`: Cloudflare Hyperdrive. Only a probe through Hyperdrive can verify a cell; the one this repository
 *   records is `docs/evidence/hyperdrive/vektorprogrammet-reimagined-0000-results.md`, taken from another project's
 *   deployed Worker. This repository's own probe Worker is a later spec (`docs/wizard/hyperdrive-probe.md`).
 *
 * `seeds` name the items of the research report (`REPORT.md`, 2026-10-29) that a row comes from.
 */

const docs = (outcome: Outcome, note: string): Cell => ({
  note,
  outcome,
  verifiedBy: "docs",
});

const probed = (outcome: Outcome, note: string): Cell => ({
  note,
  outcome,
  verifiedBy: "pgbouncer-probe",
});

const throughHyperdrive = (outcome: Outcome, note: string): Cell => ({
  note,
  outcome,
  verifiedBy: "hyperdrive-probe",
});

/** Read or measured somewhere this repository cannot reproduce, or not at all. */
const unverified = (outcome: Outcome, note: string): Cell => ({
  note,
  outcome,
  verifiedBy: "unverified",
});

const hyperdriveEvidence =
  "docs/evidence/hyperdrive/vektorprogrammet-reimagined-0000-results.md";

const pgDocs = "https://www.postgresql.org/docs/current";
const pgBouncerFeatures = "https://www.pgbouncer.org/features.html";
const pgBouncerConfig = "https://www.pgbouncer.org/config.html";

const hyperdrivePooling =
  "https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/";

const hyperdriveSupported =
  "https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/";

const hyperdriveLimits =
  "https://developers.cloudflare.com/hyperdrive/platform/limits/";

export const catalogue = [
  {
    behaviour:
      "The server connection belongs to the client for as long as the client is connected",
    direct: docs("works", "One client, one PostgreSQL session."),
    hyperdrive: docs(
      "scoped",
      "The connection is the client's only for the duration of a transaction."
    ),
    id: "session-scope",
    seeds: ["H1"],
    sources: [hyperdrivePooling, `${pgBouncerConfig}#pool_mode`],
    transactionPooled: docs(
      "scoped",
      "Assigned to a client only during a transaction, then back in the pool."
    ),
  },
  {
    behaviour:
      "SET or RESET of session state (search_path, timezone, statement_timeout) outside a transaction",
    direct: docs("works", "The setting lasts for the session."),
    hyperdrive: docs(
      "scoped",
      "Supported for a transaction or a query; the connection is RESET when it returns to the pool."
    ),
    id: "set-session",
    probe: "leak-search-path",
    seeds: ["H2", "M1"],
    sources: [`${pgDocs}/sql-set.html`, hyperdrivePooling, pgBouncerFeatures],
    transactionPooled: probed(
      "leaks",
      "The next client on the same server connection sees the setting; no error."
    ),
  },
  {
    behaviour: "set_config(name, value, false): a session-level setting",
    direct: docs("works", "The setting lasts for the session."),
    hyperdrive: unverified(
      "unknown",
      "Not documented: Hyperdrive documents SET, not set_config; unsupported if it counts as per-session state."
    ),
    id: "set-config-session",
    probe: "leak-set-config-session",
    seeds: ["H2", "H5", "M1"],
    sources: [
      `${pgDocs}/functions-admin.html#FUNCTIONS-ADMIN-SET`,
      hyperdriveSupported,
    ],
    transactionPooled: probed(
      "leaks",
      "Same as SET: the value is visible to the next client on the server connection."
    ),
  },
  {
    behaviour:
      "SET LOCAL and set_config(name, value, true): a setting for one transaction",
    direct: docs("works", "Reverts at COMMIT or ROLLBACK."),
    hyperdrive: docs(
      "works",
      "SET is supported for the duration of a transaction."
    ),
    id: "set-local",
    probe: "scoped-set-local",
    seeds: ["H2", "M1"],
    sources: [`${pgDocs}/sql-set.html`, hyperdrivePooling],
    transactionPooled: probed(
      "works",
      "Visible inside the transaction, gone after it; the next client on the server connection sees the default."
    ),
  },
  {
    behaviour: "A transaction that stays open",
    direct: docs("works", "Holds one session, which the client owns anyway."),
    hyperdrive: docs(
      "degrades",
      "The origin connection cannot be reused by another Worker isolate until the transaction ends."
    ),
    id: "long-transaction",
    seeds: ["H3"],
    sources: [hyperdrivePooling, `${pgBouncerConfig}#pool_mode`],
    transactionPooled: docs(
      "degrades",
      "The server connection stays assigned to the client, so other clients wait for a free one."
    ),
  },
  {
    behaviour:
      "Named prepared statements at the protocol level (Parse with a name), the pooler tracks them",
    direct: docs("works", "The statement lives in the session."),
    hyperdrive: docs(
      "works",
      "Supported as implemented by postgres.js and node-postgres; Hyperdrive replays Parse on the connection it checks out. Other drivers may not be supported."
    ),
    id: "named-statements-tracked",
    probe: "named-statement-tracked",
    seeds: ["H4", "H14", "M2a"],
    sources: [
      hyperdrivePooling,
      "https://blog.cloudflare.com/postgres-named-prepared-statements-supported-hyperdrive/",
      `${pgBouncerConfig}#max_prepared_statements`,
    ],
    transactionPooled: probed(
      "works",
      "With max_prepared_statements above 0 PgBouncer prepares the statement on whichever server connection a client gets."
    ),
  },
  {
    behaviour:
      "Named prepared statements at the protocol level, the pooler does not track them (PgBouncer max_prepared_statements = 0)",
    direct: docs("works", "The statement lives in the session."),
    hyperdrive: docs(
      "works",
      "Hyperdrive tracks named statements itself (previous row); this configuration does not exist there."
    ),
    id: "named-statements-untracked",
    probe: "known-issue-named-statements",
    seeds: ["H4", "M2b"],
    sources: [
      `${pgBouncerConfig}#max_prepared_statements`,
      "https://github.com/Effect-TS/effect/issues/8320",
    ],
    transactionPooled: probed(
      "breaks",
      "Known issue, pinned: a statement name is bound to one server connection, so clients fail with 42P05 (already exists; 26000, does not exist, in some runs) and clients that share a name get each other's SQL. The hang measured with @effect/sql-pg 4.0.6 (report M2b, 4 of 4 runs) needs that client; node-postgres fails loudly instead, and the hang is not reproduced here."
    ),
  },
  {
    behaviour:
      "Unnamed extended-protocol statements (a driver's prepare: false, or any parameterised query without a name)",
    direct: docs("works", "Parse, Bind, Execute in one exchange."),
    hyperdrive: docs(
      "breaks",
      "Cloudflare's postgres.js page: prepare: false 'can cause queries to hang or fail intermittently'; it also makes queries uncacheable. Whether another client's unnamed path (one write, as @effect/sql-pg does) is safe is not documented."
    ),
    id: "unnamed-statements",
    probe: "unnamed-statements",
    seeds: ["H11", "M2b"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/",
      `${pgDocs}/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY`,
    ],
    transactionPooled: probed(
      "works",
      "Transactions of unnamed parameterised queries ran correctly (800 of 800 in the probe, with max_prepared_statements 0; the matrix also runs 1000 and pool sizes 1 and 5)."
    ),
  },
  {
    behaviour: "SQL-level PREPARE, EXECUTE, DEALLOCATE, DISCARD",
    direct: docs("works", "The statement lives in the session."),
    hyperdrive: docs("unsupported", "Listed as not supported."),
    id: "sql-prepare",
    probe: "leak-sql-prepare",
    seeds: ["H5", "M1"],
    sources: [
      `${pgDocs}/sql-prepare.html`,
      hyperdriveSupported,
      pgBouncerFeatures,
    ],
    transactionPooled: probed(
      "leaks",
      "The prepared statement stays on the server connection and is visible to the next client."
    ),
  },
  {
    behaviour: "Session-level advisory locks (pg_advisory_lock)",
    direct: docs(
      "works",
      "Held by the session until unlocked; another session cannot take it."
    ),
    hyperdrive: docs(
      "unsupported",
      "Advisory locks are listed as not supported."
    ),
    id: "advisory-session",
    probe: "leak-advisory-session",
    seeds: ["H5", "M1"],
    sources: [
      `${pgDocs}/explicit-locking.html#ADVISORY-LOCKS`,
      hyperdriveSupported,
      pgBouncerFeatures,
    ],
    transactionPooled: probed(
      "leaks",
      "Two clients on one server connection both hold the lock: false mutual exclusion, no error."
    ),
  },
  {
    behaviour: "Transaction-level advisory locks (pg_advisory_xact_lock)",
    direct: docs("works", "Released at the end of the transaction."),
    hyperdrive: unverified(
      "unknown",
      "Hyperdrive lists 'advisory locks' as unsupported without distinguishing the transaction-level ones."
    ),
    id: "advisory-xact",
    probe: "scoped-advisory-xact",
    seeds: ["H5", "H6"],
    sources: [
      `${pgDocs}/explicit-locking.html#ADVISORY-LOCKS`,
      hyperdriveSupported,
    ],
    transactionPooled: probed(
      "works",
      "Excludes another client while the transaction is open and is released at its end."
    ),
  },
  {
    behaviour: "LISTEN",
    direct: docs("works", "Notifications reach the listening session."),
    hyperdrive: docs(
      "unsupported",
      "LISTEN and NOTIFY are listed as not supported."
    ),
    id: "listen",
    probe: "leak-listen",
    seeds: ["H5", "M1"],
    sources: [
      `${pgDocs}/sql-listen.html`,
      hyperdriveSupported,
      pgBouncerFeatures,
    ],
    transactionPooled: probed(
      "leaks",
      "The channel stays registered on the server connection, so a later client holds it."
    ),
  },
  {
    behaviour: "NOTIFY",
    direct: docs("works", "Delivered at commit."),
    hyperdrive: docs(
      "unsupported",
      "LISTEN and NOTIFY are listed as not supported."
    ),
    id: "notify",
    seeds: ["H5"],
    sources: [
      `${pgDocs}/sql-notify.html`,
      hyperdriveSupported,
      pgBouncerFeatures,
    ],
    transactionPooled: docs(
      "works",
      "PgBouncer's feature table lists NOTIFY as supported in transaction pooling."
    ),
  },
  {
    behaviour:
      "Any other change to per-session state (LOAD, session roles, session variables)",
    direct: docs("works", "The change lasts for the session."),
    hyperdrive: docs(
      "unsupported",
      "'Any modification to per-session state not explicitly documented as supported elsewhere' is listed as not supported."
    ),
    id: "other-session-state",
    seeds: ["H5"],
    sources: [hyperdriveSupported, pgBouncerFeatures],
    transactionPooled: docs(
      "leaks",
      "PgBouncer's transaction mode breaks session-based features; the application must not use them."
    ),
  },
  {
    behaviour:
      "Temporary tables that keep their rows (the default, ON COMMIT PRESERVE ROWS)",
    direct: docs("works", "The table lives in the session."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "temp-table-preserve",
    probe: "leak-temp-preserve-rows",
    seeds: ["H6", "M1"],
    sources: [`${pgDocs}/sql-createtable.html`, pgBouncerFeatures],
    transactionPooled: probed(
      "leaks",
      "The table stays on the server connection and the next client can read it."
    ),
  },
  {
    behaviour:
      "Temporary tables that end with the transaction (ON COMMIT DROP)",
    direct: docs("works", "Dropped at commit."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "temp-table-on-commit-drop",
    probe: "scoped-temp-on-commit-drop",
    seeds: ["H6"],
    sources: [`${pgDocs}/sql-createtable.html`, pgBouncerFeatures],
    transactionPooled: probed(
      "works",
      "Usable inside the transaction and gone after it."
    ),
  },
  {
    behaviour: "Cursors that outlive the transaction (DECLARE ... WITH HOLD)",
    direct: docs("works", "The cursor lives in the session."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "with-hold-cursor",
    probe: "leak-with-hold-cursor",
    seeds: ["H6", "M1"],
    sources: [`${pgDocs}/sql-declare.html`, pgBouncerFeatures],
    transactionPooled: probed(
      "leaks",
      "The cursor stays on the server connection and is visible to the next client."
    ),
  },
  {
    behaviour: "Cursors inside one transaction (DECLARE, FETCH)",
    direct: docs("works", "Closed at the end of the transaction."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "cursor-in-transaction",
    probe: "scoped-cursor-in-transaction",
    seeds: ["H6"],
    sources: [`${pgDocs}/sql-declare.html`],
    transactionPooled: probed(
      "works",
      "Fetched inside the transaction and gone after it."
    ),
  },
  {
    behaviour: "COPY",
    direct: docs("works", "Streams rows over the connection."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "copy",
    seeds: ["H6"],
    sources: [`${pgDocs}/sql-copy.html`],
    transactionPooled: unverified(
      "unknown",
      "PgBouncer's feature table does not list COPY; not probed here."
    ),
  },
  {
    behaviour:
      "The client goes away in the middle of a transaction (a cancelled request, a closed socket)",
    direct: probed(
      "works",
      "The session ends and the transaction is rolled back; its locks are released."
    ),
    evidence: hyperdriveEvidence,
    hyperdrive: throughHyperdrive(
      "breaks",
      "Measured on a deployed Worker: without the enable_request_signal compatibility flag an aborted request's transaction committed 20 s later (3 of 3 runs); with it, it rolled back after about 0.2 s (3 of 3)."
    ),
    id: "request-abort",
    probe: "abort-rolls-back",
    seeds: ["H6", "L3"],
    sources: [
      "https://developers.cloudflare.com/workers/configuration/compatibility-flags/",
      "https://developers.cloudflare.com/workers/platform/limits/",
      `${pgDocs}/protocol-flow.html#PROTOCOL-FLOW-TERMINATION`,
    ],
    transactionPooled: probed(
      "works",
      "PgBouncer closes the server connection and the transaction is rolled back."
    ),
  },
  {
    behaviour:
      "CancelRequest (the client asks the server to stop a running statement)",
    direct: probed("works", "The statement ends with 57014."),
    hyperdrive: unverified(
      "unknown",
      "Not documented; whether Hyperdrive forwards it or closes the socket is not verified."
    ),
    id: "cancel-request",
    probe: "cancel-forwarded",
    seeds: ["H6", "M4"],
    sources: [
      `${pgDocs}/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS`,
      `${pgBouncerConfig}#cancel_wait_timeout`,
    ],
    transactionPooled: probed(
      "works",
      "PgBouncer forwards the cancel to the right server connection; the statement ends with 57014."
    ),
  },
  {
    behaviour:
      "statement_timeout and a cancel both end a statement with SQLSTATE 57014",
    direct: probed(
      "works",
      "The messages differ ('statement timeout' and 'user request'), so the two can be told apart."
    ),
    hyperdrive: unverified("unknown", "Not verified through Hyperdrive."),
    id: "statement-timeout",
    probe: "statement-timeout-vs-cancel",
    seeds: ["H6", "M4"],
    sources: [
      `${pgDocs}/runtime-config-client.html#GUC-STATEMENT-TIMEOUT`,
      `${pgDocs}/errcodes-appendix.html`,
    ],
    transactionPooled: probed(
      "works",
      "The same two messages arrive through PgBouncer; SET LOCAL statement_timeout applies to the transaction only."
    ),
  },
  {
    behaviour:
      "BEGIN ISOLATION LEVEL (and READ ONLY) as part of the opening statement",
    direct: docs("works", "Sets the transaction's isolation level."),
    hyperdrive: unverified(
      "unknown",
      "Not documented; a downstream project asserts READ COMMITTED through Hyperdrive on previews, not re-run here."
    ),
    id: "isolation-level",
    probe: "pattern-isolation",
    seeds: ["H6"],
    sources: [`${pgDocs}/transaction-iso.html`, hyperdrivePooling],
    transactionPooled: probed(
      "works",
      "BEGIN ISOLATION LEVEL and SET LOCAL in one script apply (one round trip), and SERIALIZABLE refuses one of two write-skew transactions with 40001."
    ),
  },
  {
    behaviour: "Savepoints (nested transactions)",
    direct: docs("works", "A failed inner part rolls back to its savepoint."),
    evidence: hyperdriveEvidence,
    hyperdrive: throughHyperdrive(
      "works",
      "Check 4 of the downstream run: an inner failure, then the outer commit."
    ),
    id: "savepoints",
    probe: "pattern-savepoint",
    seeds: ["H6", "L4"],
    sources: [`${pgDocs}/sql-savepoint.html`],
    transactionPooled: probed(
      "works",
      "The inner failure rolls back to the savepoint and the outer transaction commits."
    ),
  },
  {
    behaviour:
      "Row locks (SELECT ... FOR UPDATE, SKIP LOCKED) inside a transaction",
    direct: docs("works", "The lock is held until the transaction ends."),
    hyperdrive: unverified(
      "unknown",
      "Not measured through Hyperdrive in the downstream run."
    ),
    id: "row-locks",
    probe: "pattern-row-lock",
    seeds: ["H6"],
    sources: [`${pgDocs}/explicit-locking.html#LOCKING-ROWS`],
    transactionPooled: probed(
      "works",
      "20 concurrent withdrawals through a 2-connection pool kept the total exact."
    ),
  },
  {
    behaviour: "INSERT ... ON CONFLICT ... RETURNING as a claim",
    direct: docs("works", "Exactly one concurrent inserter gets the row back."),
    evidence: hyperdriveEvidence,
    hyperdrive: throughHyperdrive(
      "works",
      "Check 5 (DO NOTHING and DO UPDATE) and check 8 (20 concurrent upserts on one key: one row) of the downstream run."
    ),
    id: "on-conflict",
    probe: "pattern-on-conflict-claim",
    seeds: ["L4"],
    sources: [`${pgDocs}/sql-insert.html#SQL-ON-CONFLICT`],
    transactionPooled: probed(
      "works",
      "20 concurrent claims of one key through a 2-connection pool: exactly one winner."
    ),
  },
  {
    behaviour:
      "SQLSTATE reaches the client (23505, 40001, 40P01), so a failure can be classified and retried",
    direct: docs("works", "Every error carries its SQLSTATE."),
    evidence: hyperdriveEvidence,
    hyperdrive: throughHyperdrive(
      "works",
      "Check 6 of the downstream run classified a unique violation by its SQLSTATE. Errors with no PostgreSQL equivalent use 58000."
    ),
    id: "sqlstate-passthrough",
    probe: "pattern-retry",
    seeds: ["H9", "L4"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/",
      `${pgDocs}/mvcc-serialization-failure-handling.html`,
    ],
    transactionPooled: probed(
      "works",
      "A serialization failure (40001) and a deadlock (40P01) both arrive and a whole-transaction retry commits."
    ),
  },
  {
    behaviour: "A statement or an idle connection that runs for a long time",
    direct: docs("works", "No limit unless statement_timeout is set."),
    hyperdrive: docs(
      "breaks",
      "A query over 60 seconds is terminated; an idle connection is closed after 10 minutes."
    ),
    id: "statement-duration-cap",
    seeds: ["H7"],
    sources: [hyperdriveLimits, `${pgBouncerConfig}#query_timeout`],
    transactionPooled: docs("works", "query_timeout is 0 (off) by default."),
  },
  {
    behaviour: "How many connections the database sees",
    direct: docs("works", "One per client, up to max_connections."),
    hyperdrive: docs(
      "degrades",
      "About 20 (Free) or 100 (Paid) origin connections per configuration; a second pool can exceed that."
    ),
    id: "origin-connection-limit",
    seeds: ["H7"],
    sources: [hyperdriveLimits, `${pgBouncerConfig}#default_pool_size`],
    transactionPooled: docs(
      "works",
      "default_pool_size caps the server connections per database and user."
    ),
  },
  {
    behaviour: "Every connection is in use when a client asks for one",
    direct: docs(
      "breaks",
      "'too many clients already' once max_connections is reached."
    ),
    hyperdrive: docs(
      "breaks",
      "'Failed to acquire a connection from the pool'; long transactions are a common cause."
    ),
    id: "pool-exhaustion",
    seeds: ["H8"],
    sources: [
      hyperdriveLimits,
      `${pgBouncerConfig}#query_wait_timeout`,
      `${pgDocs}/runtime-config-connection.html#GUC-MAX-CONNECTIONS`,
    ],
    transactionPooled: docs(
      "degrades",
      "The client waits up to query_wait_timeout (120 s in Neon's profile), then fails."
    ),
  },
  {
    behaviour: "Errors that PostgreSQL does not define",
    direct: docs("works", "Every error has a PostgreSQL SQLSTATE."),
    hyperdrive: docs(
      "differs",
      "An error that does not map to a PostgreSQL code uses 58000; others pass through unchanged when possible."
    ),
    id: "error-codes",
    seeds: ["H9"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/",
    ],
    transactionPooled: unverified(
      "unknown",
      "PgBouncer's own errors (query_wait_timeout, pool full) use its own codes; not catalogued here."
    ),
  },
  {
    behaviour: "Reads are cached and never invalidated",
    direct: docs("works", "Every read reaches the database."),
    hyperdrive: docs(
      "differs",
      "Caching is on by default; a write does not purge cached reads; reads with STABLE or VOLATILE functions (NOW(), RANDOM()) are not cached."
    ),
    id: "query-cache",
    seeds: ["H10"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/concepts/query-caching/",
    ],
    transactionPooled: docs("works", "PgBouncer does not cache."),
  },
  {
    behaviour: "Reads inside a transaction are cached",
    direct: docs("works", "Every read reaches the database."),
    hyperdrive: unverified(
      "unknown",
      "The caching page does not say whether reads inside a transaction are cached."
    ),
    id: "query-cache-in-transaction",
    seeds: ["H10"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/concepts/query-caching/",
    ],
    transactionPooled: docs("works", "PgBouncer does not cache."),
  },
  {
    behaviour: "Drizzle ORM with the postgres.js driver",
    direct: docs("works", "A supported pairing."),
    hyperdrive: docs(
      "unsupported",
      "'Pairing Drizzle ORM with the Postgres.js driver over Hyperdrive is not currently supported.'"
    ),
    id: "drizzle-postgres-js",
    seeds: ["H12"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/",
    ],
    transactionPooled: unverified("unknown", "Not examined."),
  },
  {
    behaviour:
      "A driver-level connection pool created at the top of the script",
    direct: docs("works", "A pool is meant to live as long as the process."),
    hyperdrive: docs(
      "breaks",
      "Create clients inside the request handler; a global pool 'will leave you with stale connections that result in failed queries and hard errors'."
    ),
    id: "client-lifecycle",
    seeds: ["H13"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/",
      "https://node-postgres.com/features/pooling",
    ],
    transactionPooled: docs(
      "works",
      "A long-lived driver pool in front of PgBouncer is the normal setup."
    ),
  },
  {
    behaviour: "Local development and tests",
    direct: docs("works", "The code talks to PostgreSQL."),
    hyperdrive: docs(
      "differs",
      "Local development connects directly to the database and bypasses Hyperdrive, so no local run passes through the pooler."
    ),
    id: "local-development",
    seeds: ["H15"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/configuration/local-development/",
    ],
    transactionPooled: docs(
      "works",
      "Applies when a PgBouncer is part of the local setup; the harness of this repository starts one."
    ),
  },
  {
    behaviour:
      "A pooled database endpoint behind Hyperdrive (a pooler behind a pooler)",
    direct: docs("works", "Not applicable: there is no first pooler."),
    hyperdrive: docs(
      "unsupported",
      "For Neon, use the direct endpoint: 'uncheck the connection pooling checkbox'."
    ),
    id: "pooled-endpoint-behind-hyperdrive",
    seeds: ["H16"],
    sources: [
      "https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/",
    ],
    transactionPooled: unverified("unknown", "Not examined."),
  },
  {
    behaviour: "Changing a Hyperdrive configuration",
    direct: docs("works", "Not applicable."),
    hyperdrive: docs(
      "differs",
      "Updating the settings does not tear down the existing pool; the old origin connections wait for the 10-minute idle timeout, so origin connections can double."
    ),
    id: "config-update",
    seeds: ["H17"],
    sources: [
      "https://github.com/alchemy-run/alchemy/issues/1807",
      "https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/",
    ],
    transactionPooled: docs("works", "Not applicable."),
  },
  {
    behaviour: "Several statements in flight on one connection (pipelining)",
    direct: docs("works", "Supported by the protocol."),
    hyperdrive: unverified("unknown", "Not documented either way."),
    id: "pipelining",
    probe: "pipelining",
    seeds: ["M3"],
    sources: [
      `${pgDocs}/protocol-flow.html#PROTOCOL-FLOW-PIPELINING`,
      "https://supabase.com/docs/guides/database/connecting-to-postgres",
    ],
    transactionPooled: probed(
      "works",
      "16 clients with 50 queries in flight each (node-postgres pipeline: true) got every answer back in order behind PgBouncer. Supabase documents pipelining as unsupported in its transaction mode, so this is pooler-specific."
    ),
  },
] as const satisfies readonly Row[];

export type CatalogueRow = (typeof catalogue)[number];

export type RowId = CatalogueRow["id"];

/** Every probe that a row names, in catalogue order. */
export const probeIds = catalogue.flatMap((row) =>
  "probe" in row ? [row.probe] : []
);

export const rowById = (id: RowId): CatalogueRow => {
  const row = catalogue.find((candidate) => candidate.id === id);

  if (row === undefined) {
    throw new Error(`no catalogue row ${id}`);
  }

  return row;
};
