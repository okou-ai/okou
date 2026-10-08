import { command } from "ccstate";
import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { accept } from "../../lib/accept.ts";
import { reloadAgents$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { rootSignal$ } from "../root-signal.ts";
import { createDraftSignals } from "./chat-draft.ts";
import { createAgent } from "./create-agent.ts";
import { setJobsDialogOpen$ } from "./jobs-page.ts";
import { setAgentPinned$ } from "./pinned-agents.ts";

const sendAgentSetupThread$ = command(
  async (
    { set },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const sent = await set(
      sendNewThread$,
      {
        agentId,
        draft: createDraftSignals(),
        prompt,
        generationTemplate: undefined,
        preserveAgentDraft: true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!sent) {
      throw new Error("Unable to start the Agent setup thread");
    }
  },
);

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

    // Both requests start together, but a failed prompt must not discard an
    // Agent that creation already committed and leave the dialog retryable.
    const [created, setupPrompt] = await Promise.allSettled([
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
    if (created.status === "rejected") {
      throw created.reason;
    }
    const agent = created.value;
    set(reloadAgents$);
    set(setJobsDialogOpen$, false);
    if (setupPrompt.status === "rejected") {
      throw setupPrompt.reason;
    }

    await set(
      setAgentPinned$,
      { agentId: agent.agentId, pinned: true },
      signal,
    );
    signal.throwIfAborted();

    // Navigation aborts the page signal; the root-owned send must finish.
    await set(
      sendAgentSetupThread$,
      agent.agentId,
      setupPrompt.value.body.prompt,
      get(rootSignal$),
    );
  },
);
