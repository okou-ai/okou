import { command } from "ccstate";
import { agentDeletionError } from "@okouai/core/agent-protection";
import { toast } from "@okouai/ui/components/ui/sonner";
import { agentsByIdContract } from "@okouai/api-contracts/client/agents";
import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import { reloadAgents$ } from "../../agent.ts";
import { i18n } from "../../../i18n/index.ts";
import {
  currentAgentVisibleWorkflows$,
  reloadWorkflows$,
} from "../../workflows-page/workflows-signals.ts";

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

export const deleteAgent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const identityError = agentDeletionError(detail.isDefaultAgent);
    if (identityError) {
      throw new Error(identityError.message);
    }

    // Confirm the current workflow list before deleting its source agent.
    set(reloadWorkflows$);
    await get(currentAgentVisibleWorkflows$);
    signal.throwIfAborted();

    const client = get(apiClient$)(agentsByIdContract);
    await accept(
      client.delete({
        params: { id: detail.agentId },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    signal.throwIfAborted();

    toast.success(
      i18n.t(
        ($) => {
          return $.delete.success;
        },
        { ns: "agents" },
      ),
    );
    // Refresh the agents list only. Do NOT reload the agent-by-id cache here:
    // the just-deleted agent is still subscribed via currentAgent$ until the
    // caller navigates away, so reloading it would refetch a deleted agent and
    // surface an "Agent not found" error toast on top of the success toast.
    set(reloadAgents$);
  },
);
