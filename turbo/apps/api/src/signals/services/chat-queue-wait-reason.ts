/**
 * Why a chat input that was just enqueued is (not yet) running, observed after
 * its enqueue's pick has finished (design §5.2).
 *
 * - `running`: the thread has an active run; this enqueue launched it, or the
 *   input steers into the running run.
 * - `thread-busy`: another picker holds the thread lease and is working on it.
 * - `org-full`: neither; the input waits for an organization concurrency slot.
 */
export type ChatQueueWaitReason = "running" | "thread-busy" | "org-full";

export interface ChatQueuePickResult {
  readonly reason: ChatQueueWaitReason;
}
