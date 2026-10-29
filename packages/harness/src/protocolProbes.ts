import { setTimeout as sleep } from "node:timers/promises";

import { classifyFailure, failureOf } from "@pg-txmode/core";
import type { FailureKind } from "@pg-txmode/core";
import { sendCancelRequest } from "@pg-txmode/core/cancel";

import { breaks, withSessions, works } from "./probe.ts";
import type { Observation, Probe, Target } from "./probe.ts";
import { pgConnect, rejection } from "./session.ts";
import type { Session } from "./session.ts";

const longStatement = "SELECT pg_sleep(30)";

/** Polls PostgreSQL itself until `text` is running on some backend: the cancel must not land before the statement starts. */
const untilActive = async (target: Target, text: string): Promise<void> => {
  await withSessions(pgConnect(target.direct.url), 1, async ([observer]) => {
    for (let tries = 0; tries < 500; tries += 1) {
      const rows = await observer?.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query = $1 AND pid <> pg_backend_pid()",
        [text]
      );

      if (Number(rows?.[0]?.n) > 0) {
        return;
      }

      await sleep(10);
    }

    throw new Error(`the statement ${text} was not running after 5 s`);
  });
};

/** Starts a long statement in a transaction on `session`, cancels it once it is running, and returns how it ended. */
const cancelledStatement = async (
  target: Target,
  session: Session
): Promise<Error | undefined> => {
  await session.query("BEGIN");

  const running = rejection(session.query(longStatement));

  await untilActive(target, longStatement);
  await sendCancelRequest(target.endpoint, session.cancelKey);

  return await running;
};

const sqlStateOf = (error: Error | undefined): string | undefined =>
  error === undefined ? undefined : failureOf(error)?.sqlState;

const errorText = (error: Error | undefined): string =>
  error === undefined ? "no error" : `${sqlStateOf(error)} ${error.message}`;

/** The kind the policy reads from the error's own message and SQLSTATE, with no hint from the client. */
const kindOf = (error: Error | undefined): FailureKind | undefined =>
  error === undefined
    ? undefined
    : classifyFailure({
        message: error.message,
        sqlState: sqlStateOf(error) ?? "",
      }).kind;

/** M4: a CancelRequest sent to the endpoint the client is connected to ends the running statement. */
const cancelForwarded: Probe = {
  id: "cancel-forwarded",
  maxPreparedStatements: 1000,
  poolSize: 1,
  run: async (target) =>
    await withSessions(target.connect, 1, async ([session]) => {
      const started = Date.now();

      const error =
        session === undefined
          ? undefined
          : await cancelledStatement(target, session);

      const elapsed = Date.now() - started;
      const detail = `${errorText(error)} after ${elapsed} ms`;

      return sqlStateOf(error) === "57014" && elapsed < 5000
        ? works(detail)
        : breaks(detail);
    }),
};

/**
 * What the server says tells a statement timeout from a cancel, both SQLSTATE 57014. The classification must come out of
 * the message alone (no hint from the client), because an adapter cannot always know.
 */
const statementTimeoutVsCancel: Probe = {
  id: "statement-timeout-vs-cancel",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withSessions(
      target.connect,
      2,
      async ([timeoutSession, cancelSession]) => {
        if (timeoutSession === undefined || cancelSession === undefined) {
          return breaks("no sessions");
        }

        await timeoutSession.query("BEGIN");
        await timeoutSession.query("SET LOCAL statement_timeout = 200");

        const timedOut = await rejection(
          timeoutSession.query("SELECT pg_sleep(5)")
        );

        const cancelled = await cancelledStatement(target, cancelSession);
        const detail = `timeout: ${errorText(timedOut)} => ${kindOf(timedOut)}; cancel: ${errorText(cancelled)} => ${kindOf(cancelled)}`;

        return kindOf(timedOut) === "statement-timeout" &&
          kindOf(cancelled) === "user-cancel"
          ? works(detail)
          : breaks(detail);
      }
    ),
};

/**
 * A table in PostgreSQL itself (not behind the pooler) and an observer connected to PostgreSQL, for the probes that ask
 * whether a victim client's lock outlives it. The table is dropped afterwards, waiting for any lock the victim still holds.
 */
const withObserverTable = async (
  target: Target,
  table: string,
  use: (observer: Session) => Promise<Observation>
): Promise<Observation> =>
  await withSessions(pgConnect(target.direct.url), 1, async ([observer]) => {
    if (observer === undefined) {
      return breaks("no observer");
    }

    await observer.query(`CREATE TABLE ${table} (k int PRIMARY KEY)`);

    try {
      return await use(observer);
    } finally {
      await observer.query("SET lock_timeout = 0");
      await observer.query(`DROP TABLE ${table}`);
    }
  });

/**
 * H6 and L3 on a local pooler: a client whose socket closes in the middle of a transaction leaves nothing committed and
 * no lock behind, while its backend is idle in the transaction.
 */
const abortRollsBack: Probe = {
  id: "abort-rolls-back",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withObserverTable(target, "abort_probe", async (observer) => {
      const victim = await target.connect();

      await victim.query("BEGIN");
      await victim.query("INSERT INTO abort_probe VALUES (1)");
      victim.destroy();
      await sleep(500);

      // The lock on key 1 is free once the transaction is rolled back; a held lock makes this insert wait and fail.
      await observer.query("SET lock_timeout = 2000");

      const refused = await rejection(
        observer.query("INSERT INTO abort_probe VALUES (1)")
      );

      const rows = await observer.query(
        "SELECT count(*)::int AS n FROM abort_probe"
      );

      return refused === undefined && Number(rows[0]?.n) === 1
        ? works(
            "the victim's insert was rolled back and its lock released: the observer inserted the same key"
          )
        : breaks(
            `the observer could not insert the victim's key: ${refused?.message}`
          );
    }),
};

const busyStatement = "SELECT pg_sleep(3)";

/**
 * The same client, closed while its backend is running a statement: the server does not look at the socket until the
 * statement ends (`client_connection_check_interval` is 0 by default), so the victim's lock is still held. Observed
 * directly and through the pooler; the pooler cannot release what PostgreSQL still holds.
 */
const abortBusyHoldsLocks: Probe = {
  id: "abort-busy-holds-locks",
  maxPreparedStatements: 1000,
  poolSize: 2,
  run: async (target) =>
    await withObserverTable(target, "abort_busy_probe", async (observer) => {
      const victim = await target.connect();

      await victim.query("BEGIN");
      await victim.query("INSERT INTO abort_busy_probe VALUES (1)");

      const running = rejection(victim.query(busyStatement));

      await untilActive(target, busyStatement);
      victim.destroy();
      await observer.query("SET lock_timeout = 500");

      const refused = await rejection(
        observer.query("INSERT INTO abort_busy_probe VALUES (1)")
      );

      await running;

      return refused === undefined
        ? works("the observer inserted the victim's key at once")
        : breaks(
            `the observer waited and failed while the victim's statement still ran: ${refused.message}`
          );
    }),
};

export const protocolProbes: readonly Probe[] = [
  cancelForwarded,
  statementTimeoutVsCancel,
  abortRollsBack,
  abortBusyHoldsLocks,
];
