/**
 * Why a chat input that was just enqueued is (not yet) running. Returned by
 * the single enqueue entry and by pick so integrations and the web sender can
 * explain the wait without re-deriving queue state.
 *
 * - `launched`: this pick started a run from the thread's queue head.
 * - `steering`: the thread has a running run; a sandbox runner steers the
 *   pending prompt into it.
 * - `thread-busy`: the thread's slot is taken (or another picker holds the
 *   lease); the input runs after the current work.
 * - `org-full`: the organization is at its concurrent run limit, including a
 *   launch that returned CONCURRENT_RUN_LIMIT.
 * - `rejected`: the head was consumed as `input.rejected`.
 */
export type ChatQueueWaitReason =
  | "launched"
  | "steering"
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
