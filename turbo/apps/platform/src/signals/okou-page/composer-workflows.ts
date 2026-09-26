import { computed, type Computed } from "ccstate";
import {
  workflowsCollectionContract,
  type ComposerWorkflow,
} from "@okouai/api-contracts/contracts/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { workflowReloadVersion$ } from "../workflows-page/workflow-reload.ts";

type AgentIdValue = string | null | Promise<string | null>;

export function createComposerWorkflows<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
): Computed<Promise<readonly ComposerWorkflow[]>> {
  return computed(async (get): Promise<readonly ComposerWorkflow[]> => {
    const agentId = await get(agentIdSource$);
    if (!agentId) {
      return [];
    }
    get(workflowReloadVersion$);
    const client = get(apiClient$)(workflowsCollectionContract);
    const result = await accept(client.composer({ query: { agentId } }), [200]);
    return result.body;
  });
}
