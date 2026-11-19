import { command, computed, state } from "ccstate";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
  type ChatActionCallback,
} from "../chat-page/action-callback.ts";
import { pageVersion$ } from "../page-signal.ts";
import { searchParams$ } from "../route.ts";

interface CompletedCallback {
  readonly agentId: string;
  readonly callback: ChatActionCallback;
}

const pageCompletedCallback$ = computed((get) => {
  get(pageVersion$);
  return state<CompletedCallback | null>(null);
});

function completedSameCallback(
  previous: CompletedCallback | null,
  agentId: string,
  callback: ChatActionCallback,
): boolean {
  return (
    previous?.agentId === agentId &&
    previous.callback.threadId === callback.threadId &&
    previous.callback.callbackPrompt === callback.callbackPrompt
  );
}

export const pendingDirectedConnectorCallback$ = computed((get) => {
  const callback = get(routeChatActionCallback$);
  const agentId = get(searchParams$).get("agentId");
  if (!agentId || !callback.threadId || !callback.callbackPrompt?.trim()) {
    return false;
  }
  return !completedSameCallback(
    get(get(pageCompletedCallback$)),
    agentId,
    callback,
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
      const completedCallback$ = get(pageCompletedCallback$);
      if (completedSameCallback(get(completedCallback$), agentId, callback)) {
        return;
      }
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
      set(completedCallback$, { agentId, callback });
    }
  },
);
