/**
 * The caller's `AbortSignal` fired during a transaction. The connection was closed, which PostgreSQL answers by rolling
 * the transaction back (catalogue row `request-abort`). When `outcomeUnknown` is true the abort came after `COMMIT` was
 * sent: the transaction may have committed, and only an idempotency key can tell.
 */
export class TransactionAbortedError extends Error {
  override readonly name = "TransactionAbortedError";
  readonly outcomeUnknown: boolean;

  constructor(outcomeUnknown: boolean) {
    super(
      outcomeUnknown
        ? "the transaction was aborted after COMMIT was sent: it may have committed"
        : "the transaction was aborted before COMMIT: it was rolled back"
    );
    this.outcomeUnknown = outcomeUnknown;
  }
}
