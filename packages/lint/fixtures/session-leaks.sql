-- Statements that break behind a transaction pooler: `bun packages/lint/src/cli.ts --mode hyperdrive <this file>`.
-- Not a test (the lint's tests build their own SQL): the PR's journey needs something for the lint to find.
SET search_path = tenant_a;
SELECT set_config('app.tenant', 'a', false);
LISTEN orders;
SELECT pg_advisory_lock(42);
PREPARE find_user AS SELECT * FROM users WHERE id = $1;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
