/**
 * Why a chat input that was just enqueued is (not yet) running. Observed from
 * the input's own chat event after its enqueue's pick has finished, never from
 * that pick's return value: another picker holding the thread lease may have
 * launched or rejected the input meanwhile.
 *
 * - `launched`: a run claimed the input (its revoking row carries a `runId`).
 * - `rejected`: the input was consumed without a run: revoked by
 *   `input.rejected`, or recalled by the user (`control.revoke`).
 * - `thread-busy`: the input is still pending and the thread's slot is taken
 *   (or a picker holds the lease); it runs after the current work.
 * - `org-full`: the input is still pending, the thread is idle, and the
 *   organization is at its concurrent run limit.
 */
export type ChatQueueWaitReason =
  | "launched"
  | "thread-busy"
  | "org-full"
  | "rejected";

export interface ChatQueuePickResult {
  readonly reason: ChatQueueWaitReason;
  /** The run that claimed the input, when `reason` is `launched`. */
  readonly runId?: string;
  /** The consumed input event, when `reason` is `launched` or `rejected`. */
  readonly eventId?: string;
}
