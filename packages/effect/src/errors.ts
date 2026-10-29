import { Schema } from "effect";

/**
 * The mode cannot honour what the caller asked for (a feature the catalogue marks `no`, or `unverified` without
 * `allowUnverified`, or a named statement on a pooler that does not track them). The message, the row and the sources are
 * the core's `UnsupportedFeatureError`, quoted unchanged: this package has no text about poolers of its own.
 */
export class ModeRefusedError extends Schema.TaggedError<
  ModeRefusedError,
  { readonly brand: unique symbol }
>()("ModeRefusedError", {
  feature: Schema.String,
  message: Schema.String,
  mode: Schema.String,
  row: Schema.String,
  sources: Schema.Array(Schema.String),
  support: Schema.Literals(["no", "unverified"]),
}) {}

/** A transaction option the core's `timeoutStatements` refuses (a timeout that is not a non-negative integer). */
export class InvalidTransactionOptionsError extends Schema.TaggedError<
  InvalidTransactionOptionsError,
  { readonly brand: unique symbol }
>()("InvalidTransactionOptionsError", { message: Schema.String }) {}

/**
 * `transaction` ran inside a transaction of the same client. A nested transaction is a savepoint: it keeps the outer
 * isolation level, timeouts and retry, so the options would be dropped silently, and a retry inside a savepoint cannot
 * help because the outer transaction is already aborted. Use `sql.withTransaction` for a savepoint.
 */
export class NestedTransactionError extends Schema.TaggedError<
  NestedTransactionError,
  { readonly brand: unique symbol }
>()("NestedTransactionError", { message: Schema.String }) {}

/** The server connection that holds a session advisory lock ended while the body was running. */
export class AdvisoryLockLostError extends Schema.TaggedError<
  AdvisoryLockLostError,
  { readonly brand: unique symbol }
>()("AdvisoryLockLostError", { cause: Schema.Defect(), key: Schema.Int }) {}
