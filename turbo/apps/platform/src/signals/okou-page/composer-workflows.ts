import { command, computed, state, type Computed } from "ccstate";
import { workflowsCollectionContract } from "@okouai/api-contracts/client/workflows";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { workflowReloadVersion$ } from "../workflows-page/workflow-reload.ts";
import { authenticatedSessionKey$ } from "../auth.ts";

const recencyVersion$ = state(0);

export const reloadComposerWorkflowRecency$ = command(({ set }) => {
  set(recencyVersion$, (version) => {
    return version + 1;
  });
});

type AgentIdValue = string | null | Promise<string | null>;

export function createComposerWorkflows<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
): Computed<Promise<readonly ComposerWorkflow[]>> {
  return computed(async (get): Promise<readonly ComposerWorkflow[]> => {
    get(authenticatedSessionKey$);
    get(recencyVersion$);
    get(workflowReloadVersion$);
    const createClient = get(apiClient$);
    const agentId = await get(agentIdSource$);
    if (!agentId) {
      return [];
    }
    const client = createClient(workflowsCollectionContract);
    const result = await accept(client.composer({ query: { agentId } }), [200]);
    return result.body;
  });
}
