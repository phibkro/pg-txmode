export { catalogue, probeIds, rowById } from "./catalogue.ts";

export type { CatalogueRow, RowId } from "./catalogue.ts";

export { columns } from "./catalogueTypes.ts";

export type {
  Cell,
  Column,
  Outcome,
  Row,
  VerifiedBy,
} from "./catalogueTypes.ts";

export {
  capabilities,
  cellOf,
  columnOf,
  describeMode,
  direct,
  featureRows,
  hyperdrive,
  neonPooler,
  pgBouncer,
  requireFeature,
  sessionOnlyFeatures,
  sessionPooled,
  supavisor,
  UnsupportedFeatureError,
} from "./mode.ts";

export type {
  Capabilities,
  ConnectionMode,
  DirectMode,
  Feature,
  FeatureOptions,
  PreparedStatements,
  SessionApi,
  SessionOnlyFeature,
  SessionPooledMode,
  Support,
  TransactionPooledMode,
} from "./mode.ts";

export {
  claim,
  claimJob,
  conditionalUpdate,
  dropExampleSchema,
  exampleSchema,
  outbox,
  outboxDelivery,
  patterns,
  rowLock,
  savepoint,
  transactionContext,
} from "./patterns.ts";

export type { Pattern } from "./patterns.ts";

export {
  beginMarker,
  endMarker,
  renderCatalogueTable,
  withCatalogueTable,
} from "./render.ts";

export { encodeLogEntry } from "./statementLog.ts";

export type { StatementLogEntry } from "./statementLog.ts";

export { classifyFailure, failureOf } from "./sqlstate.ts";

export type {
  ClassifyInput,
  Failure,
  FailureKind,
  RetryClass,
  SqlError,
} from "./sqlstate.ts";

export {
  backoffMs,
  beginStatement,
  defaultRetryPolicy,
  InvalidTimeoutError,
  openingScript,
  openingStatements,
  retryDecision,
  timeoutStatements,
  withTransactionRetry,
} from "./transaction.ts";

export type {
  IsolationLevel,
  RetryDecision,
  RetryEnvironment,
  RetryPolicy,
  Timeouts,
  TransactionOptions,
} from "./transaction.ts";
