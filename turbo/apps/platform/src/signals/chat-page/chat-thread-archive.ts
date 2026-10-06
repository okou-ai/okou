import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { setChatThreadArchived$ } from "./chat-event.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";

export const setChatThreadArchivedFromHeader$ = command(
  async (
    { get, set },
    {
      threadId,
      agentId,
      archived,
    }: { threadId: string; agentId: string; archived: boolean },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(chatThreadMetaMap$).get(threadId)?.archived === archived) {
      return;
    }
    await set(setChatThreadArchived$, { threadId, archived }, signal);
    signal.throwIfAborted();
    if (archived) {
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId },
      });
    }
  },
);
