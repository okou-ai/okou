import { command, computed, state } from "ccstate";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
  type ChatActionCallback,
  type ChatActionCallbackIds,
} from "../chat-page/action-callback.ts";
import { pageVersion$ } from "../page-signal.ts";
import { searchParams$ } from "../route.ts";

interface CallbackAttempt {
  readonly agentId: string;
  readonly callback: ChatActionCallback;
  readonly ids: ChatActionCallbackIds;
  readonly completed: boolean;
}

const pageCallbackAttempt$ = computed((get) => {
  get(pageVersion$);
  return state<CallbackAttempt | null>(null);
});

function matchesCallback(
  previous: CallbackAttempt | null,
  agentId: string,
  callback: ChatActionCallback,
): previous is CallbackAttempt {
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
  const attempt = get(get(pageCallbackAttempt$));
  return !matchesCallback(attempt, agentId, callback) || !attempt.completed;
});

/** Continue the requesting chat only after the directed action has completed. */
export const completeDirectedConnectorAction$ = command(
  async (
    { get, set },
    agentId: string | null,
    callback: ChatActionCallback,
    signal: AbortSignal,
  ) => {
    if (!agentId || !callback.callbackPrompt || !callback.threadId) {
      return;
    }
    const attempt$ = get(pageCallbackAttempt$);
    const previous = get(attempt$);
    const attempt = matchesCallback(previous, agentId, callback)
      ? previous
      : {
          agentId,
          callback,
          ids: {
            clientEventId: crypto.randomUUID(),
            chatThreadSortEventId: crypto.randomUUID(),
          },
          completed: false,
        };
    if (attempt.completed) {
      return;
    }
    set(attempt$, attempt);
    await set(
      runChatActionCallback$,
      {
        agentId,
        threadId: callback.threadId,
        callbackPrompt: callback.callbackPrompt,
        callbackIds: attempt.ids,
      },
      signal,
    );
    signal.throwIfAborted();
    if (get(attempt$) === attempt) {
      set(attempt$, { ...attempt, completed: true });
    }
  },
);
