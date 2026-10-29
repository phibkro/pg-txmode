import { leakProbes } from "./leakProbes.ts";
import { patternProbes } from "./patternProbes.ts";
import type { Observation, Probe, Target } from "./probe.ts";
import { neonProfile } from "./profile.ts";
import { protocolProbes } from "./protocolProbes.ts";
import { scopedProbes } from "./scopedProbes.ts";
import { pgConnect } from "./session.ts";
import { startPgBouncer } from "./stack.ts";
import type { Postgres } from "./stack.ts";
import { statementProbes } from "./statementProbes.ts";

/** Every probe of the harness. The catalogue names each by `probe`; a test keeps the two lists equal. */
export const probes: readonly Probe[] = [
  ...leakProbes,
  ...scopedProbes,
  ...statementProbes,
  ...protocolProbes,
  ...patternProbes,
];

export interface ProbeRun {
  readonly id: string;
  /** PostgreSQL itself: the control. */
  readonly direct: Observation;
  /** PgBouncer in transaction mode, Neon's settings with the probe's pool size and prepared-statement setting. */
  readonly pooled: Observation;
}

const targetOf = (postgres: Postgres, url: string, port: number): Target => ({
  connect: pgConnect(url),
  direct: postgres.endpoint,
  endpoint: { ...postgres.endpoint, port, url },
});

/**
 * Runs one probe against PostgreSQL and against a fresh PgBouncer in transaction mode (fresh, so a probe that leaks
 * session state leaves nothing for the next one).
 */
export const runProbe = async (
  postgres: Postgres,
  probe: Probe
): Promise<ProbeRun> => {
  const direct = await probe.run(
    targetOf(postgres, postgres.endpoint.url, postgres.endpoint.port)
  );

  const pooler = await startPgBouncer(postgres, {
    ...neonProfile(postgres.maxConnections),
    defaultPoolSize: probe.poolSize,
    maxPreparedStatements: probe.maxPreparedStatements,
  });

  try {
    const pooled = await probe.run(
      targetOf(postgres, pooler.endpoint.url, pooler.endpoint.port)
    );

    return { direct, id: probe.id, pooled };
  } finally {
    await pooler.stop();
  }
};

/** Every probe, one after another: they share the server and its tables. */
export const runAll = async (
  postgres: Postgres
): Promise<readonly ProbeRun[]> =>
  await probes.reduce<Promise<readonly ProbeRun[]>>(
    async (previous, probe) => [
      ...(await previous),
      await runProbe(postgres, probe),
    ],
    Promise.resolve([])
  );
