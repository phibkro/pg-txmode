# Wizard: the Hyperdrive probe Worker (human steps, nothing here has been run)

Status: **planned, not built, not run.** The catalogue's Hyperdrive column has `unverified` and `unknown` cells because the only way to verify a Hyperdrive behaviour is to run the probe suite through Hyperdrive, and that needs Cloudflare credentials that only the operator has. This file writes the steps for the operator, so that nobody improvises them. An agent does not run them.

The rule for the result: a Hyperdrive cell becomes `hyperdrive-probe` only when the run's raw output is recorded under `docs/evidence/hyperdrive/` and the row's `evidence` names the file (the catalogue test checks both).

## What the Worker does

The same probe suite as `packages/harness`, with the connection replaced by the Hyperdrive binding. Each probe opens its own client inside the request handler (Cloudflare's rule: never a client in the global scope, `docs` row `client-lifecycle`), runs, and returns its observation as JSON. The runner on the operator's machine compares each answer to the catalogue row and writes the report.

Probes that need two clients on one server connection (the leak probes) cannot force that through Hyperdrive, which owns the pool; they run many times and record how often a client saw another's state. A leak that never shows in N runs is `unknown`, not `works`.

## Steps

Each step names who acts. Credentials are the operator's; they are read from files by key name and never printed.

1. **Operator: choose the database.** A throwaway PostgreSQL that is not production data. Neon's direct endpoint works (`docs` row `pooled-endpoint-behind-hyperdrive`: not the pooled one). Create a role with rights on one empty database only.
2. **Operator: store the secrets.** Put the database password in the project's secret store (SecretSpec) and the Cloudflare API token in the file the Alchemy provider reads. Check them by key name and length only (`jq 'map_values(length)'`).
3. **Operator: create the Hyperdrive configuration** with caching **disabled** for the run, and again with caching enabled for the cache probes. With `cf` (the machine's Cloudflare CLI, pinned in the lockfile, `DO_NOT_TRACK=1`): find the command with `cf cli search hyperdrive`; pass the password through stdin, never as an argument.
4. **Operator: deploy the Worker** with the compatibility flags `nodejs_compat` and, for the run that tests request abort, with and without `enable_request_signal` (catalogue row `request-abort`). Alchemy v2 declares the Worker and the Hyperdrive binding; the Worker's only database address is the binding.
5. **Operator: run the runner** against the Worker's URL from a clean checkout: `bun run probes:hyperdrive -- --url <worker>` (to be written with the Worker; not in this repository yet). Keep the raw output.
6. **Operator: record the evidence.** Copy the raw output to `docs/evidence/hyperdrive/<date>-probe.md`, with the Worker's script version, the compatibility flags, the PostgreSQL version and the Hyperdrive configuration's caching setting (no identifiers, no hostnames, no secrets).
7. **Agent, after the operator commits the evidence:** update the catalogue cells the run settled (`hyperdrive-probe`, `evidence` path), regenerate the README (`bun run docs:gen`), and open a PR.
8. **Operator: tear down.** Delete the Worker and the Hyperdrive configurations; revoke the token and the database role. Alchemy destroys what it created; `cf` removes what `cf` created.

## What this wizard does not do

- It does not deploy anything by itself and it is not a script: every step that touches Cloudflare or the database is the operator's.
- It does not claim a result. Until step 6 exists, the Hyperdrive column says what the documentation and the downstream run say, and nothing more.
