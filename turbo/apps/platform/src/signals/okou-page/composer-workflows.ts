import { computed } from "ccstate";
import { workflowsCollectionContract } from "@okouai/api-contracts/client/workflows";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { workflowReloadVersion$ } from "../workflows-page/workflow-reload.ts";

export const composerWorkflows$ = computed(
  async (get): Promise<readonly ComposerWorkflow[]> => {
    get(workflowReloadVersion$);
    const client = get(apiClient$)(workflowsCollectionContract);
    const result = await accept(client.composer({ query: {} }), [200]);
    return result.body;
  },
);
