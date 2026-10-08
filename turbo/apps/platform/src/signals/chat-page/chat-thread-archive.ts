import { command } from "ccstate";
import { navigateTo$ } from "../route.ts";
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
    if (!archived) {
      await set(setChatThreadArchived$, { threadId, archived }, signal);
      return;
    }
    // The archive is optimistic, so leave the thread without waiting for the
    // request. The caller passes a root-scoped signal because this navigation
    // aborts the current page signal.
    await Promise.all([
      set(setChatThreadArchived$, { threadId, archived }, signal),
      set(
        navigateTo$,
        "/agents/:agentId/chat",
        { pathParams: { agentId } },
        signal,
      ),
    ]);
  },
);
