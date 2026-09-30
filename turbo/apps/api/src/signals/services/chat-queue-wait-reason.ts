/**
 * Why a chat input that was just enqueued is (not yet) running, observed after
 * its enqueue's pick has finished (design §5.2).
 *
 * - `handled`: the input was already consumed: a run claimed it, it was
 *   rejected, or the user recalled it.
 * - `running`: the thread has an active run; the input steers into it.
 * - `org-full`: neither; the input waits for an organization concurrency slot.
 */
export type ChatQueueWaitReason = "handled" | "running" | "org-full";

export interface ChatQueuePickResult {
  readonly reason: ChatQueueWaitReason;
}
