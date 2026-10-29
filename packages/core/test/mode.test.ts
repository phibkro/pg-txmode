import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import {
  capabilities,
  direct,
  hyperdrive,
  neonPooler,
  pgBouncer,
  requireFeature,
  sessionOnlyFeatures,
  sessionPooled,
  supavisor,
  UnsupportedFeatureError,
} from "../src/index.ts";
import type {
  ConnectionMode,
  SessionApi,
  TransactionPooledMode,
} from "../src/index.ts";

const sessionOnlyAllowed = (mode: ConnectionMode) =>
  sessionOnlyFeatures.filter(
    (feature) => capabilities(mode)[feature] === "yes"
  );

describe("capabilities", () => {
  test("a direct connection and a session pooler keep every session-only feature", () => {
    expect(sessionOnlyAllowed(direct)).toStrictEqual([...sessionOnlyFeatures]);
    expect(sessionOnlyAllowed(sessionPooled)).toStrictEqual([
      ...sessionOnlyFeatures,
    ]);
  });

  test("Hyperdrive allows no session-only feature", () => {
    expect(sessionOnlyAllowed(hyperdrive)).toStrictEqual([]);
  });

  test("PgBouncer in transaction mode allows NOTIFY and nothing else that lives in the session", () => {
    expect(sessionOnlyAllowed(pgBouncer(1000))).toStrictEqual(["notify"]);
  });

  test("prepared statements follow what the pooler tracks", () => {
    expect(capabilities(direct).preparedStatements).toBe("named-protocol");
    expect(capabilities(hyperdrive).preparedStatements).toBe("named-protocol");
    expect(capabilities(neonPooler).preparedStatements).toBe("named-protocol");
    expect(capabilities(pgBouncer(1000)).preparedStatements).toBe(
      "named-protocol"
    );
    expect(capabilities(pgBouncer(0)).preparedStatements).toBe("unnamed-only");
    expect(capabilities(supavisor).preparedStatements).toBe("unnamed-only");
  });

  test("only Hyperdrive caches reads, and Supavisor does not pipeline", () => {
    expect(capabilities(hyperdrive).cachesReads).toBe(true);
    expect(capabilities(pgBouncer(1000)).cachesReads).toBe(false);
    expect(capabilities(direct).cachesReads).toBe(false);
    expect(capabilities(supavisor).pipelining).toBe("no");
    expect(capabilities(pgBouncer(1000)).pipelining).toBe("yes");
  });

  test("a behaviour nobody has verified is 'unverified', never 'yes'", () => {
    expect(capabilities(hyperdrive).rowLocks).toBe("unverified");
    expect(capabilities(hyperdrive).cancelRequest).toBe("unverified");
  });

  test("the verified Hyperdrive behaviours are 'yes' and the one that breaks is 'no'", () => {
    expect(capabilities(hyperdrive).savepoints).toBe("yes");
    expect(capabilities(hyperdrive).onConflict).toBe("yes");
    expect(capabilities(hyperdrive).requestAbortRollsBack).toBe("no");
  });
  test("transaction-local settings work everywhere that was measured", () => {
    expect(capabilities(hyperdrive).transactionLocalSettings).toBe("yes");
    expect(capabilities(pgBouncer(1000)).transactionLocalSettings).toBe("yes");
  });
});

describe("requireFeature", () => {
  test("passes for a supported feature", () => {
    expect(() => {
      requireFeature(direct, "listen");
    }).not.toThrow();
    expect(() => {
      requireFeature(pgBouncer(1000), "transactionLocalSettings");
    }).not.toThrow();
  });

  test("refuses a session-only feature on a pooled mode and quotes the catalogue row and its sources", () => {
    expect(() => {
      requireFeature(hyperdrive, "listen");
    }).toThrow(UnsupportedFeatureError);
    expect(() => {
      requireFeature(hyperdrive, "listen");
    }).toThrow(/catalogue row listen.*https:\/\/developers\.cloudflare\.com/u);
    expect(() => {
      requireFeature(pgBouncer(1000), "sessionSet");
    }).toThrow(/catalogue row set-session/u);
  });

  test("refuses an unverified feature unless the caller accepts it", () => {
    expect(() => {
      requireFeature(hyperdrive, "rowLocks");
    }).toThrow(/unverified/u);
    expect(() => {
      requireFeature(hyperdrive, "rowLocks", { allowUnverified: true });
    }).not.toThrow();
  });

  test("never lets allowUnverified through a feature that is known to fail", () => {
    expect(() => {
      requireFeature(hyperdrive, "listen", { allowUnverified: true });
    }).toThrow(UnsupportedFeatureError);
  });
});

describe("SessionApi", () => {
  interface Listener {
    readonly listen: (channel: string) => void;
  }

  test("is the API on a direct or session-pooled mode and never on a transaction-pooled one", () => {
    expectTypeOf<
      SessionApi<typeof direct, Listener>
    >().toEqualTypeOf<Listener>();
    expectTypeOf<
      SessionApi<typeof sessionPooled, Listener>
    >().toEqualTypeOf<Listener>();
    expectTypeOf<SessionApi<TransactionPooledMode, Listener>>().toBeNever();
    expectTypeOf<SessionApi<typeof hyperdrive, Listener>>().toBeNever();
  });
});
