import { command } from "ccstate";

import { configureChatRunFinishedEventCommand$ } from "./chat-run-finished-event-dispatch.service";
import { dispatchChatRunFinishedAutomationEvents$ } from "./chat-run-finished-automation-event.service";
import { scheduleModelBusyRetry$ } from "./chat-model-busy-retry.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";

const dispatchChatRunFinished$ = command(
  async ({ set }, event: ChatRunFinishedEvent, signal: AbortSignal) => {
    await Promise.all([
      set(scheduleModelBusyRetry$, event, signal),
      set(dispatchChatRunFinishedAutomationEvents$, event, signal),
    ]);
  },
);

/** Wire the chat-run-finished implementation into the request's command graph. */
export const configureChatRunFinishedEventDispatcher$ = command(
  ({ set }): void => {
    set(configureChatRunFinishedEventCommand$, dispatchChatRunFinished$);
  },
);
