import { command } from "ccstate";
import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { sessionOutputDeltaSchema } from "@okouai/api-contracts/validators/realtime";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import { createActiveRunSubscription } from "./active-run-subscription.ts";
import { appendOptimisticSessionOutput$ } from "./optimistic-chat-events.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";

const L = logger("SessionOutputStream");

export function createSessionOutputStreamSignals(
  threadId: string,
  {
    chatEvents$,
    activeRunId$,
  }: Pick<ChatEventSignals, "chatEvents$" | "activeRunId$">,
) {
  const receive$ = command(
    async (
      { get, set },
      payload: unknown,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      const result = sessionOutputDeltaSchema.safeParse(payload);
      if (
        !result.success ||
        result.data.threadId !== threadId ||
        result.data.runId !== get(activeRunId$)
      ) {
        return false;
      }
      const events = get(chatEvents$);
      const persisted = events.filter((event): event is PersistedChatEvent => {
        return event.seqId !== undefined;
      });
      if (set(appendOptimisticSessionOutput$, result.data, persisted)) {
        await set(notifyChatEventsChanged$, chatEvents$, signal);
      }
      return false;
    },
  );
  const streamRunOutput$ = command(
    ({ set }, runId: string, signal: AbortSignal): void => {
      set(
        setAblyPayloadLoop$,
        {
          scope: "run-output",
          topic: runId,
          loopCommand$: receive$,
          options: {
            onError: (error) => {
              L.warn("Session output subscription failed", error);
            },
          },
        },
        signal,
      );
    },
  );
  const stream = createActiveRunSubscription(
    chatEvents$,
    activeRunId$,
    streamRunOutput$,
  );
  const subscribe$ = command(({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    set(stream.subscribe$, signal);
  });
  return { subscribe$ };
}
