import { createRunSlotPickScheduler } from "./run-slot-pick-scheduler";
import { pickOrgQueuedChatThreads$ } from "./chat-thread-queue-drain.service";

/**
 * After the slot release commits: org-pick each
 * organization that got a slot back, in its own background task per
 * organization, independent of the path's other side effects. Call it before
 * those effects so a failing or slow terminal callback cannot delay it.
 */
export const scheduleReleasedSlotPicks$ = createRunSlotPickScheduler(
  pickOrgQueuedChatThreads$,
);
