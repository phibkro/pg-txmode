import {
  capabilities,
  cellOf,
  describeMode,
  requireFeature,
  rowById,
  UnsupportedFeatureError,
} from "@pg-txmode/core";
import type { ConnectionMode, Feature } from "@pg-txmode/core";
import { Array as Arr, Effect } from "effect";

import { ModeRefusedError } from "./errors.ts";

/**
 * The core's `requireFeature` as an effect: it succeeds when the mode supports the feature (or the feature is unverified
 * and the caller accepts that) and fails with `ModeRefusedError` quoting the catalogue row, its note and its sources. The
 * decision is the core's; the core throws, the throw is a defect inside `Effect.sync`, and only its refusal is turned into
 * the typed error (any other defect stays one).
 */
export const requireModeFeature = (
  mode: ConnectionMode,
  feature: Feature,
  allowUnverified: boolean
): Effect.Effect<void, ModeRefusedError> =>
  Effect.sync(() => {
    requireFeature(mode, feature, { allowUnverified });
  }).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof UnsupportedFeatureError
        ? Effect.fail(
            new ModeRefusedError({
              feature: defect.feature,
              message: defect.message,
              mode: describeMode(mode),
              row: defect.row,
              sources: defect.sources,
              support: defect.support === "unverified" ? "unverified" : "no",
            })
          )
        : Effect.die(defect)
    )
  );

/**
 * Named prepared statements on a pooler that does not track them: the catalogue row `named-statements-untracked` (the M2b
 * class: 26000 and 42P05 errors, a hang with `@effect/sql-pg`, or another client's SQL). Only `prepare: true` asks for them.
 */
export const requireNamedStatements = (
  mode: ConnectionMode
): Effect.Effect<void, ModeRefusedError> => {
  if (capabilities(mode).preparedStatements === "named-protocol") {
    return Effect.void;
  }

  const row = rowById("named-statements-untracked");

  return Effect.fail(
    new ModeRefusedError({
      feature: "namedStatements",
      message: `prepare: true is refused on a ${describeMode(mode)} connection: ${cellOf(mode, row.id).note} Leave prepare unset (the layer sends unnamed statements) or use a pooler that tracks named statements [catalogue row ${row.id}, ${Arr.join(row.sources, ", ")}]`,
      mode: describeMode(mode),
      row: row.id,
      sources: row.sources,
      support: "no",
    })
  );
};
