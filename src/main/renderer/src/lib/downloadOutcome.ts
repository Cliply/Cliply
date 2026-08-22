/**
 * Terminal download outcomes.
 *
 * A download now finishes through `download:progress` events, not through the
 * IPC promise. The hook's event handler is the single owner of those outcomes:
 * it updates state, shows the toast and stages the report. It then rejects the
 * mutation with one of these reasons purely to unblock whoever is awaiting it.
 *
 * React Query's `onError` and the calling components must stay silent for these
 * — otherwise a failure is toasted and reported twice, and a cancellation is
 * presented as a failure.
 */

export type TerminalOutcome = "failed" | "cancelled" | "abandoned"

export class TerminalDownloadReason extends Error {
  readonly outcome: TerminalOutcome
  readonly alreadyReported = true

  constructor(outcome: TerminalOutcome, message: string) {
    super(message)
    this.name = "TerminalDownloadReason"
    this.outcome = outcome
  }
}

export function terminalReason(
  outcome: TerminalOutcome,
  message: string
): TerminalDownloadReason {
  return new TerminalDownloadReason(outcome, message)
}

/** Has this error already been surfaced by the hook's event path? */
export function isTerminalReason(error: unknown): error is TerminalDownloadReason {
  return (
    error instanceof TerminalDownloadReason ||
    Boolean(error && (error as { alreadyReported?: boolean }).alreadyReported)
  )
}
