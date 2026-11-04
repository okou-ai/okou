import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import {
  primaryHeaderPresence$,
  secondaryHeaderPresence$,
  secondaryHeaderThreadId$,
  type ChatHeaderPresence,
} from "../../signals/chat-page/chat-header-actions.ts";
import { currentLeftThread$ } from "../../signals/chat-page/chat-thread-pane-state.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";

export interface ChatHeaderActionsState {
  readonly mail: boolean;
  readonly automations: boolean;
  readonly pending: boolean;
  readonly transitioning: boolean;
}

// No matching pane is a navigation gap, not a new confirmed button layout.
function retainHeaderDuringNavigation(
  _previous: ChatHeaderPresence | null,
  next: ChatHeaderPresence | null,
) {
  return next === null;
}

/** Call from a stable pane or shell leaf, outside the thread-keyed subtree. */
export function useChatHeaderActions(
  thread: ChatPanelSignals | null,
  secondary?: boolean,
): ChatHeaderActionsState {
  const primaryThread = useGet(currentLeftThread$);
  const isSecondary = secondary ?? thread?.threadId !== primaryThread?.threadId;
  const source$ = isSecondary
    ? secondaryHeaderPresence$
    : primaryHeaderPresence$;
  const last = useLastLoadable(source$, {
    equalityFn: retainHeaderDuringNavigation,
  });
  const currentResult = useLoadable(source$);
  const requestedId = useGet(
    isSecondary ? secondaryHeaderThreadId$ : currentChatThreadId$,
  );
  const presence = last.state === "hasData" ? last.data : null;
  const current = thread !== null && requestedId === thread.threadId;
  return {
    mail: presence?.mail ?? false,
    automations: presence?.automations ?? false,
    pending:
      !current ||
      currentResult.state === "loading" ||
      (currentResult.state === "hasData" && currentResult.data === null),
    transitioning: !current || presence?.threadId !== thread?.threadId,
  };
}
