import { state } from "ccstate";

export interface ChatInputEnqueueCommit {
  readonly eventId: string;
  /** Request-local observation immediately after the enqueue commit resolves. */
  readonly committedAt: number;
}

/**
 * Receipts belong to the existing request Store, including its waitUntil work.
 * Only the exact event may use its observation. A cron or another request has
 * no receipt, so it cannot report an enqueue-commit-to-consume duration.
 * Updates replace the map; the empty default is never mutated.
 */
export const chatInputEnqueueCommits$ = state<ReadonlyMap<string, number>>(
  new Map(),
);
