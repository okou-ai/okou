import { command } from "ccstate";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { createNewChatThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { searchParams$ } from "../route.ts";
import { expandProject$ } from "./project-folders.ts";
import { waitForProjectCreation$ } from "./projects.ts";

export const newProjectThread$ = command(
  async ({ get, set }, projectId: string, signal: AbortSignal) => {
    const agentId =
      get(searchParams$).get("projectAgent") ??
      (await get(currentChatAgentRecordId$));
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Select an Agent before starting a conversation");
    }
    set(expandProject$, projectId);
    await set(waitForProjectCreation$, projectId, signal);
    await set(createNewChatThread$, { agentId, projectId }, "main", signal);
  },
);
