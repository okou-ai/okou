import { command } from "ccstate";
import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { accept } from "../../lib/accept.ts";
import { reloadAgents$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { rootSignal$ } from "../root-signal.ts";
import { createDraftSignals } from "./chat-draft.ts";
import { createAgent } from "./create-agent.ts";
import { setAgentPinned$ } from "./pinned-agents.ts";

/**
 * Create a sub-agent by composing via the agents API.
 * Follows the same flow as onboarding: create agent → upload instructions.
 */
export const createSubagent$ = command(
  async (
    { get, set },
    displayName: string,
    avatarUrl: string,
    visibility: "public" | "private",
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);

    await createAgent(
      createClient,
      {
        displayName,
        avatarUrl,
        visibility,
      },
      signal,
    );
    signal.throwIfAborted();

    // Refresh the agents list so the new agent appears immediately
    set(reloadAgents$);
  },
);

/**
 * Create a sub-agent, pin it, and open a new thread asking it to adopt the
 * responsibility the user described by updating its description and
 * instructions.
 */
export const createSubagentWithSetupThread$ = command(
  async (
    { get, set },
    args: {
      readonly displayName: string;
      readonly avatarUrl: string;
      readonly visibility: "public" | "private";
      readonly responsibility: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(apiClient$);

    // Draft the setup prompt while the agent is created to hide its latency.
    const [agent, setupPrompt] = await Promise.all([
      createAgent(
        createClient,
        {
          displayName: args.displayName,
          avatarUrl: args.avatarUrl,
          visibility: args.visibility,
        },
        signal,
      ),
      accept(
        createClient(agentSetupPromptsContract).create({
          body: {
            agentName: args.displayName,
            responsibility: args.responsibility,
          },
          fetchOptions: { signal },
        }),
        [200],
      ),
    ]);
    signal.throwIfAborted();

    set(reloadAgents$);
    await set(
      setAgentPinned$,
      { agentId: agent.agentId, pinned: true },
      signal,
    );

    // Navigation aborts the page signal; the root-owned send must finish.
    await set(
      sendNewThread$,
      {
        agentId: agent.agentId,
        draft: createDraftSignals(),
        prompt: setupPrompt.body.prompt,
        generationTemplate: undefined,
        preserveAgentDraft: true,
      },
      get(rootSignal$),
    );
  },
);
