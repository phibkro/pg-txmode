/**
 * The positive constructs: the plain SQL that gets an atomic result through a transaction pooler, with no session state.
 * Not a query builder. Each pattern is executed by the harness (`packages/harness/test/patterns.test.ts`) against
 * PgBouncer in transaction mode, and linted by `@pg-txmode/lint` in every mode (a test of that package), so the library's
 * own SQL cannot break the rules it teaches.
 *
 * Every statement here that needs a transaction says so; the rule for all of them is the one in
 * https://www.postgresql.org/docs/current/explicit-locking.html: "Once acquired, a lock is normally held until the end of
 * the transaction". A row lock taken outside a transaction is released at the end of its own statement.
 */

export interface Pattern<Statement extends string = string> {
  readonly id: string;
  readonly title: string;
  /** Catalogue rows (`RowId`) that decide whether the pattern is safe in a mode. */
  readonly rows: readonly string[];
  readonly needsTransaction: boolean;
  readonly statements: Readonly<Record<Statement, string>>;
}

/** The tables the patterns use, for a test or a demo; a real schema has its own. */
export const exampleSchema = [
  "CREATE TABLE accounts (id int PRIMARY KEY, balance bigint NOT NULL CHECK (balance >= 0))",
  "CREATE TABLE jobs (id bigserial PRIMARY KEY, state text NOT NULL DEFAULT 'queued', claimed_by text)",
  "CREATE TABLE claims (key text PRIMARY KEY, owner text NOT NULL)",
  "CREATE TABLE documents (id int PRIMARY KEY, body text NOT NULL, version int NOT NULL DEFAULT 1)",
  "CREATE TABLE orders (id bigserial PRIMARY KEY, item text NOT NULL)",
  "CREATE TABLE outbox (id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')), attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0), claim_token uuid, claimed_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, last_error text, CHECK ((claim_token IS NULL) = (claimed_until IS NULL)), CHECK (status <> 'dead' OR last_error IS NOT NULL), CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)))",
  "CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending'",
] as const;

export const dropExampleSchema =
  "DROP TABLE IF EXISTS outbox, orders, documents, claims, jobs, accounts";

export const rowLock: Pattern<"lock" | "withdraw"> = {
  id: "row-lock",
  needsTransaction: true,
  rows: ["row-locks"],
  statements: {
    // Inside BEGIN ... COMMIT: lock the row, decide in application code, then write.
    lock: "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE",
    withdraw: "UPDATE accounts SET balance = balance - $2 WHERE id = $1",
  },
  title: "Lock a row, decide, write",
};

export const claimJob: Pattern<"claim"> = {
  id: "claim-job",
  needsTransaction: false,
  rows: ["skip-locked"],
  statements: {
    // One statement: the lock and the write are atomic, and concurrent workers skip rows that are taken.
    claim:
      "WITH next AS (SELECT id FROM jobs WHERE state = 'queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET state = 'running', claimed_by = $1 FROM next WHERE jobs.id = next.id RETURNING jobs.id",
  },
  title: "Claim the next queued job",
};

export const claim: Pattern<"claim"> = {
  id: "claim",
  needsTransaction: false,
  rows: ["on-conflict"],
  statements: {
    // A row comes back for the one caller that inserted it; every other caller gets no row.
    claim:
      "INSERT INTO claims (key, owner) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING owner",
  },
  title: "Claim a key exactly once",
};

export const conditionalUpdate: Pattern<"update"> = {
  id: "conditional-update",
  needsTransaction: false,
  rows: [],
  statements: {
    // No row back means someone else wrote first: read again and decide, never overwrite.
    update:
      "UPDATE documents SET body = $3, version = version + 1 WHERE id = $1 AND version = $2 RETURNING version",
  },
  title: "Write only if nobody else wrote first",
};

export const outbox: Pattern<"insertMessage" | "insertOrder"> = {
  id: "outbox",
  needsTransaction: true,
  rows: [],
  statements: {
    // Inside one transaction: the change and the message commit together or not at all.
    insertMessage:
      "INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb) RETURNING id",
    insertOrder: "INSERT INTO orders (item) VALUES ($1) RETURNING id",
  },
  title: "Write the change and the message in one transaction",
};

/**
 * The delivery half of the outbox: at least once, with a lease, and a stale worker cannot harm a newer one. Every
 * statement is one autocommit statement and none keeps a transaction open while the message is sent.
 *
 * The protocol: `claimBatch` or `claimById` marks a row pending-and-claimed (a new `claim_token`, `claimed_until` in the
 * future, `attempts + 1`) and never marks it delivered; the worker sends; then `ack`, `release` or `bury` with the token.
 * The token condition is the fence: once the lease has lapsed and another worker has claimed the row, the old token matches
 * nothing and no row comes back, so "claim lost" is an empty result. A worker that crashes after the claim leaves the row
 * pending; it is claimed again once `claimed_until` has passed. `attempts` rises at each claim, so it is also a fencing
 * number for a downstream system. Delivery is unordered and a message can be sent twice: the id is its idempotency key.
 *
 * `claimById` uses no `SKIP LOCKED`, which is unverified on Hyperdrive (catalogue row `skip-locked`): the one conditional
 * `UPDATE` is the claim, and a second claimer waits for the row lock, re-reads the row, finds a live lease and matches
 * nothing. A row that comes back empty is held, delivered, dead or not yet due; the statement does not say which.
 * `$2` of the claims is the lease in milliseconds, `$3` of `release` the delay before the next attempt (`next_attempt_at`,
 * honoured by both claims). `bury` needs an error class (a null violates the table's CHECK), so a row ends only after a
 * recorded failure; `release` accepts a null class and then overwrites `last_error` with null, so pass one. A lease that
 * has lapsed but was not taken over does not stale its token: the late `ack` still delivers. The `status = 'pending'`
 * conditions of `ack`, `release` and `bury` are defence: every settle clears the token, so they change no result today.
 *
 * The fence relies on READ COMMITTED, PostgreSQL's default: a second claimer waits for the row lock and re-reads the row.
 * Under REPEATABLE READ the loser of a race gets a serialization failure (40001) instead of an empty result. The example
 * table is a test fixture: a real one wants the partial index `outbox_due` of `exampleSchema`, and deletes delivered rows.
 * The index and `CHECK (attempts >= 0)` of the fixture are not exercised by any test; they are there to be copied.
 */
export const outboxDelivery: Pattern<
  "ack" | "bury" | "claimBatch" | "claimById" | "release"
> = {
  id: "outbox-delivery",
  needsTransaction: false,
  rows: ["outbox-lease", "skip-locked"],
  statements: {
    ack: "UPDATE outbox SET status = 'delivered', delivered_at = now(), claim_token = NULL, claimed_until = NULL WHERE id = $1 AND claim_token = $2::uuid AND status = 'pending' RETURNING id",
    bury: "UPDATE outbox SET status = 'dead', claim_token = NULL, claimed_until = NULL, last_error = $3 WHERE id = $1 AND claim_token = $2::uuid AND status = 'pending' RETURNING id",
    claimBatch:
      "WITH due AS (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until <= now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE outbox SET claim_token = gen_random_uuid(), claimed_until = now() + $2::int * interval '1 millisecond', attempts = outbox.attempts + 1 FROM due WHERE outbox.id = due.id RETURNING outbox.id, outbox.topic, outbox.payload, outbox.claim_token::text AS claim_token, outbox.attempts",
    claimById:
      "UPDATE outbox SET claim_token = gen_random_uuid(), claimed_until = now() + $2::int * interval '1 millisecond', attempts = attempts + 1 WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until <= now()) RETURNING id, topic, payload, claim_token::text AS claim_token, attempts",
    release:
      "UPDATE outbox SET claim_token = NULL, claimed_until = NULL, next_attempt_at = now() + $3::int * interval '1 millisecond', last_error = $4 WHERE id = $1 AND claim_token = $2::uuid AND status = 'pending' RETURNING id",
  },
  title: "Deliver an outbox message at least once",
};

export const transactionContext: Pattern<"read" | "set"> = {
  id: "transaction-context",
  needsTransaction: true,
  rows: ["set-config-local"],
  statements: {
    read: "SELECT current_setting('app.actor', true) AS actor",
    // `true` makes the setting local to the transaction; `false` would be a session setting, which leaks.
    set: "SELECT set_config('app.actor', $1, true)",
  },
  title: "Pass context to a transaction",
};

export const savepoint: Pattern<"open" | "release" | "rollback"> = {
  id: "savepoint",
  needsTransaction: true,
  rows: ["savepoints"],
  statements: {
    open: "SAVEPOINT inner_work",
    release: "RELEASE SAVEPOINT inner_work",
    rollback: "ROLLBACK TO SAVEPOINT inner_work",
  },
  title: "Nest a transaction",
};

/** Every pattern, for the harness and for the lint test. */
export const patterns: readonly Pattern[] = [
  rowLock,
  claimJob,
  claim,
  conditionalUpdate,
  outbox,
  outboxDelivery,
  transactionContext,
  savepoint,
];
