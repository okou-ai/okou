import { command, computed, state } from "ccstate";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
  type ChatActionCallback,
} from "../chat-page/action-callback.ts";
import { pageSignal$ } from "../page-signal.ts";
import { searchParams$ } from "../route.ts";

const completedCallback$ = state<{
  readonly page: AbortSignal;
  readonly agentId: string;
  readonly callback: ChatActionCallback;
} | null>(null);

export const pendingDirectedConnectorCallback$ = computed((get) => {
  const callback = get(routeChatActionCallback$);
  const agentId = get(searchParams$).get("agentId");
  if (!agentId || !callback.threadId || !callback.callbackPrompt?.trim()) {
    return false;
  }
  const previous = get(completedCallback$);
  return (
    previous?.page !== get(pageSignal$) ||
    previous.agentId !== agentId ||
    previous.callback.threadId !== callback.threadId ||
    previous.callback.callbackPrompt !== callback.callbackPrompt
  );
});

/** Continue the requesting chat only after the directed action has completed. */
export const completeDirectedConnectorAction$ = command(
  async (
    { get, set },
    agentId: string | null,
    callback: ChatActionCallback,
    signal: AbortSignal,
  ) => {
    if (agentId && callback.callbackPrompt && callback.threadId) {
      const page = get(pageSignal$);
      await set(
        runChatActionCallback$,
        {
          agentId,
          threadId: callback.threadId,
          callbackPrompt: callback.callbackPrompt,
        },
        signal,
      );
      signal.throwIfAborted();
      set(completedCallback$, { page, agentId, callback });
    }
  },
);
