import type { ChatQueueWaitReason } from "./chat-queue-wait-reason";

export const CHAT_QUEUE_ORG_FULL_NOTICE =
  "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.";

/**
 * The one wait notice integrations send after enqueueing a chat input.
 * Only an org at its concurrent run limit is worth telling: a busy thread
 * runs or steers the input after the current work, and a rejection is delivered by the admission failure path.
 */
export function chatQueueWaitNotice(
  reason: ChatQueueWaitReason,
): string | null {
  return reason === "org-full" ? CHAT_QUEUE_ORG_FULL_NOTICE : null;
}
