import { computed, type Computed } from "ccstate";

import { currentChatThreadId$ } from "../agent-chat.ts";
import { searchParams$ } from "../route.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";

export interface ChatHeaderPresence {
  readonly threadId: string;
  readonly mail: boolean;
  readonly automations: boolean;
}

export const secondaryHeaderThreadId$ = computed((get) => {
  const secondary = get(searchParams$).get("sidebar");
  return secondary === get(currentChatThreadId$) ? null : secondary;
});

function createHeaderPresence(
  thread$: Computed<ChatPanelSignals | null>,
  requestedThreadId$: Computed<string | null>,
) {
  return computed(async (get): Promise<ChatHeaderPresence | null> => {
    const requestedThreadId = get(requestedThreadId$);
    const thread = get(thread$);
    // Navigation changes the route before replacing its pane. The previous
    // screen remains presentation only until the destination's state settles.
    if (
      !thread ||
      thread.threadId !== requestedThreadId ||
      !get(thread.threadExists$) ||
      get(thread.optimisticCreateUnsettled$)
    ) {
      return null;
    }
    const [mails, automations] = await Promise.allSettled([
      get(thread.mail.mails$),
      get(thread.headerAutomations.automations$),
    ]);
    return {
      threadId: thread.threadId,
      // Keep initial mail errors accessible through the existing error panel.
      mail: mails.status === "rejected" || mails.value.length > 0,
      automations:
        automations.status === "fulfilled" && automations.value.length > 0,
    };
  });
}

export const primaryHeaderPresence$ = createHeaderPresence(
  currentLeftThread$,
  currentChatThreadId$,
);
export const secondaryHeaderPresence$ = createHeaderPresence(
  currentRightThread$,
  secondaryHeaderThreadId$,
);
