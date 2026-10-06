import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { setChatThreadArchived$ } from "./chat-event.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";

export const archiveChatThreadAndReturn$ = command(
  async (
    { get, set },
    { threadId, agentId }: { threadId: string; agentId: string },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(chatThreadMetaMap$).get(threadId)?.archived) {
      return;
    }
    await set(setChatThreadArchived$, { threadId, archived: true }, signal);
    signal.throwIfAborted();
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId },
    });
  },
);
