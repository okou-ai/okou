import { command } from "ccstate";
import { writeDb$, type Db } from "../external/db";
import { touchChatThreadLastMessageAtIndependently } from "./chat-event-shared.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";

interface NativeChatThreadTouch {
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly authorizedScope?: {
    readonly userId: string;
    readonly orgId: string;
  };
}

/** A weakly consistent side effect, independent of the committed input. */
export async function touchNativeChatThread(
  database: Db,
  args: NativeChatThreadTouch,
): Promise<void> {
  await attemptChatEventSideEffect("thread_touch", args.chatThreadId, () => {
    return touchChatThreadLastMessageAtIndependently(
      database,
      args.chatThreadId,
      {
        touchedAt: args.createdAt,
        eventId: args.eventId,
        authorizedScope: args.authorizedScope,
      },
    );
  });
}

/** The ingress owns this sidebar touch after its pick and before publication. */
export const touchNativeChatThread$ = command(
  async (
    { set },
    args: NativeChatThreadTouch,
    signal: AbortSignal,
  ): Promise<void> => {
    await touchNativeChatThread(set(writeDb$), args);
    signal.throwIfAborted();
  },
);
