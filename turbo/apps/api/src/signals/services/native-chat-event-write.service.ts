import type { Db } from "../external/db";
import { touchChatThreadLastMessageAtIndependently } from "./chat-event-shared.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";

/**
 * Native ingress appends its event without an enclosing transaction; the
 * thread touch is a weakly consistent side effect attempted independently.
 */
export async function withNativeChatEventThreadTouch<T>(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly createdAt: Date;
    readonly eventId: string;
  },
  write: (writer: Db, touchThread: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return await write(db, () => {
    return attemptChatEventSideEffect("thread_touch", args.chatThreadId, () => {
      return touchChatThreadLastMessageAtIndependently(db, args.chatThreadId, {
        touchedAt: args.createdAt,
        eventId: args.eventId,
        unarchive: false,
      });
    });
  });
}
