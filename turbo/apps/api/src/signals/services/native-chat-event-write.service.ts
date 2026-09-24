import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import {
  touchChatThreadLastMessageAt,
  touchChatThreadLastMessageAtIndependently,
} from "./chat-event-shared.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";

/** Native ingress retains its legacy transaction until the fleet activates. */
export async function withNativeChatEventThreadTouch<T>(
  db: Db,
  args: {
    readonly splitWrites: boolean;
    readonly chatThreadId: string;
    readonly createdAt: Date;
    readonly eventId: string;
  },
  write: (writer: Db | Tx, touchThread: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (args.splitWrites) {
    return await write(db, () => {
      return attemptChatEventSideEffect(
        "thread_touch",
        args.chatThreadId,
        () => {
          return touchChatThreadLastMessageAtIndependently(
            db,
            args.chatThreadId,
            args.createdAt,
            args.eventId,
          );
        },
      );
    });
  }
  return await db.transaction((tx) => {
    return write(tx, () => {
      return touchChatThreadLastMessageAt(
        tx,
        args.chatThreadId,
        args.createdAt,
        args.eventId,
      );
    });
  });
}
