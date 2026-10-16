import { state } from "ccstate";

export interface ChatInputEnqueueCommit {
  readonly eventId: string;
  /** Request-local observation immediately after the enqueue commit resolves. */
  readonly committedAt: number;
  /**
   * Route-entry time of the `POST /api/chat/events` request that committed
   * this input. Only that route supplies it; other producers omit it.
   */
  readonly requestReceivedAt?: number;
}

export type ChatInputEnqueueReceipt = Omit<ChatInputEnqueueCommit, "eventId">;

/**
 * Receipts belong to the existing request Store, including its waitUntil work.
 * Only the exact event may use its observation. A cron or another request has
 * no receipt, so it cannot report an enqueue-commit-to-consume duration.
 * Updates replace the map; the empty default is never mutated.
 */
export const chatInputEnqueueCommits$ = state<
  ReadonlyMap<string, ChatInputEnqueueReceipt>
>(new Map());
