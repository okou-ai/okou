import { command } from "ccstate";
import {
  runChatActionCallback$,
  type ChatActionCallback,
} from "../chat-page/action-callback.ts";

/** Continue the requesting chat only after the directed action has completed. */
export const completeDirectedConnectorAction$ = command(
  async (
    { set },
    agentId: string | null,
    callback: ChatActionCallback,
    signal: AbortSignal,
  ) => {
    if (agentId && callback.callbackPrompt && callback.threadId) {
      await set(
        runChatActionCallback$,
        {
          agentId,
          threadId: callback.threadId,
          callbackPrompt: callback.callbackPrompt,
        },
        signal,
      );
    }
  },
);
