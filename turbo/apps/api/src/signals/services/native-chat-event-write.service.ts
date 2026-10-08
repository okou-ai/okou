import { command } from "ccstate";
import { touchChatThreadLastMessageAtIndependently$ } from "./chat-event-shared.service";
import { reportChatEventSideEffect } from "./chat-event-write-side-effects.service";
import { settleIncludingAbort } from "../utils";

interface NativeChatThreadTouch {
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly authorizedScope?: {
    readonly userId: string;
    readonly orgId: string;
  };
}

/** The ingress owns this independent sidebar touch after its committed input. */
export const touchNativeChatThread$ = command(
  async (
    { set },
    args: NativeChatThreadTouch,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = performance.now();
    const result = await settleIncludingAbort(
      set(
        touchChatThreadLastMessageAtIndependently$,
        args.chatThreadId,
        {
          touchedAt: args.createdAt,
          eventId: args.eventId,
          authorizedScope: args.authorizedScope,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "thread_touch",
      args.chatThreadId,
      startedAt,
      result,
    );
  },
);
