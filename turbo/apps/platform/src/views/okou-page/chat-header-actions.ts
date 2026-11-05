import { useGet } from "ccstate-react";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import { secondaryHeaderThreadId$ } from "../../signals/chat-page/chat-header-actions.ts";
import { currentLeftThread$ } from "../../signals/chat-page/chat-thread-pane-state.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";

/**
 * Navigation changes the route before replacing its pane, so a header can
 * still show the previous chat. Its actions stay inert until the route asks
 * for the chat on screen.
 */
export function useChatHeaderTransitioning(thread: ChatPanelSignals): boolean {
  const primary = useGet(currentLeftThread$)?.threadId === thread.threadId;
  const requestedId = useGet(
    primary ? currentChatThreadId$ : secondaryHeaderThreadId$,
  );
  return requestedId !== thread.threadId;
}
