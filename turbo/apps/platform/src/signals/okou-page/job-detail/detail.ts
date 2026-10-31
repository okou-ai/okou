import { command, computed, state } from "ccstate";
import { agentsByIdContract } from "@okouai/api-contracts/client/agents";
import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import type { AgentDetail } from "../agent-types.ts";
import { agentName$ } from "./agent-name.ts";

// ---------------------------------------------------------------------------
// Agent detail — reactive async computed
// ---------------------------------------------------------------------------

const internalDetailReload$ = state(0);

export const reloadAgentDetail$ = command(({ set }) => {
  set(internalDetailReload$, (prev) => {
    return prev + 1;
  });
});

export const agentDetail$ = computed(
  async (get): Promise<AgentDetail | null> => {
    get(internalDetailReload$);
    const name = get(agentName$);
    if (!name) {
      return null;
    }
    const client = get(apiClient$)(agentsByIdContract);
    const result = await accept(client.get({ params: { id: name } }), [200]);
    return result.body;
  },
);
