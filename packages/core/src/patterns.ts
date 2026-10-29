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
  "CREATE TABLE outbox (id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL, published_at timestamptz)",
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
  rows: ["row-locks"],
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

export const outbox: Pattern<"insertMessage" | "insertOrder" | "relay"> = {
  id: "outbox",
  needsTransaction: true,
  rows: ["row-locks"],
  statements: {
    // Inside one transaction: the change and the message commit together or not at all.
    insertMessage:
      "INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb) RETURNING id",
    insertOrder: "INSERT INTO orders (item) VALUES ($1) RETURNING id",
    // The relay: concurrent relays take different messages.
    relay:
      "UPDATE outbox SET published_at = now() WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING id, topic, payload",
  },
  title: "Write the change and the message in one transaction",
};

export const transactionContext: Pattern<"read" | "set"> = {
  id: "transaction-context",
  needsTransaction: true,
  rows: ["set-local"],
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
  transactionContext,
  savepoint,
];
