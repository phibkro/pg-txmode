// A process that starts a stack and waits to be killed: the parent of the orphan test. It prints the pooler's and the
// server's ports as one JSON line once both accept connections.
import { setTimeout as sleep } from "node:timers/promises";

import { startStack } from "../src/index.ts";

const stack = await startStack(2);

process.stdout.write(
  `${JSON.stringify({
    pooler: stack.pooler.endpoint.port,
    postgres: stack.postgres.endpoint.port,
  })}\n`
);

// Stays alive until the test kills it (the timeout only bounds a test that never does).
await sleep(600_000);
