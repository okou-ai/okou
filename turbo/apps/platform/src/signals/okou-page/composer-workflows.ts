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
    const result = await accept(
      client.composer({ query: { agentId } }),
      [200, 400],
    );
    if (result.status === 200) {
      return result.body;
    }

    // A newly promoted App can reach an API from before `/for-composer`
    // existed, which matches it as `/:workflowId` and rejects it with 400.
    // Surface: new app -> old API. Remove after that API is no longer serving
    // or retained as a rollback target.
    const list = await accept(client.list({ query: { agentId } }), [200]);
    return list.body.flatMap((workflow) => {
      return workflow.agentId === agentId && !workflow.shadowedBy
        ? [
            {
              id: workflow.id,
              name: workflow.name,
              displayName: workflow.displayName,
              description: workflow.description,
            },
          ]
        : [];
    });
  });
}
