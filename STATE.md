# State

Lifecycle: build

Now:

pg-txmode publishes five packages including the harness. Trusted publishing was observed in release run 41047699584; spec 0010 removes the fallback npm token.

Next:

- After merge, watch the first token-free publish. After it succeeds, the operator removes the npm-release secret, revokes the obsolete token, and disables token publishing for each package (spec 0010).
- Continue the README roadmap (postgres.js, Drizzle integrations, and the deployed Hyperdrive probe Worker).

Blocked:

- The Hyperdrive probe Worker needs the operator's Cloudflare credentials. Its steps are the wizard `docs/wizard/hyperdrive-probe.md`; nothing is run. Until it runs, the Hyperdrive column of the catalogue has `docs` and `unverified` cells and one other project's recorded run.
