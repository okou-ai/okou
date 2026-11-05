import { command } from "ccstate";
import { defaultAgentId$ } from "../agent.ts";
import { createNewChatThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { expandProject$ } from "./project-expansion.ts";
import { waitForProjectCreation$ } from "./projects.ts";

// Project chats belong to the default Agent; a chat's Project comes from the
// chat itself rather than from the URL that opened it.
export const newProjectThread$ = command(
  async ({ get, set }, projectId: string, signal: AbortSignal) => {
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("A default Agent is required to start a conversation");
    }
    set(expandProject$, projectId);
    await set(waitForProjectCreation$, projectId, signal);
    await set(createNewChatThread$, { agentId, projectId }, "main", signal);
  },
);
