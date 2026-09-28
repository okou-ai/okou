import type { Db } from "../external/db";
import { touchChatThreadLastMessageAtIndependently } from "./chat-event-shared.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";

/**
 * Native ingress touches its thread after the enqueue commits; the touch is a
 * weakly consistent side effect attempted independently of the input.
 */
export async function touchNativeChatThread(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly createdAt: Date;
    readonly eventId: string;
  },
): Promise<void> {
  await attemptChatEventSideEffect("thread_touch", args.chatThreadId, () => {
    return touchChatThreadLastMessageAtIndependently(db, args.chatThreadId, {
      touchedAt: args.createdAt,
      eventId: args.eventId,
    });
  });
}
