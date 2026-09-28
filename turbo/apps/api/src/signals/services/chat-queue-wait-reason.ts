/**
 * Why a chat input that was just enqueued is (not yet) running. Reported by
 * the pick after an enqueue so integrations and the web sender can
 * explain the wait without re-deriving queue state.
 *
 * - `launched`: this pick started a run from the thread's queue head.
 * - `thread-busy`: the thread's slot is taken (or another picker holds the
 *   lease); the input runs after the current work.
 * - `org-full`: the organization is at its concurrent run limit, or the
 *   launch returned 429 and the input keeps waiting.
 * - `rejected`: the head was consumed as `input.rejected`.
 */
export type ChatQueueWaitReason =
  | "launched"
  | "thread-busy"
  | "org-full"
  | "rejected";

export interface ChatQueuePickResult {
  readonly reason: ChatQueueWaitReason;
  /** The run this pick launched, when `reason` is `launched`. */
  readonly runId?: string;
  /** The queue event the launch or rejection consumed, when there was one. */
  readonly eventId?: string;
}
