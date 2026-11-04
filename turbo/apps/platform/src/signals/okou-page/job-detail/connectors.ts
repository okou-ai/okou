import { command, computed } from "ccstate";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/client/user-connectors";
import { apiClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Authorized connectors: User↔Agent↔Connector (per-agent grant)
//  - GET/PUT /api/agents/:id/user-connectors
//  - Wire data: { enabledConnectorSlugs: string[] } — connector slugs this user
//    authorized for this agent
// ---------------------------------------------------------------------------

export const agentAuthorizedConnectors$ = computed(
  async (get): Promise<string[]> => {
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return [];
    }
    const authorizations = await get(
      agentConnectorAuthorizations({ agentId: detail.agentId }),
    );
    return [...authorizations.enabledConnectorSlugs];
  },
);

export const toggleAgentConnector$ = command(
  async ({ get, set }, name: string, enabled: boolean, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const operation = enabled ? "add" : "remove";
    const client = get(apiClient$)(userBuiltinConnectorsContract);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      (async () => {
        await accept(
          client.update({
            params: { id: detail.agentId },
            body: { enabledConnectorSlugs: [name], operation },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
      })(),
      () => {
        set(reloadAgentConnectorAuthorizations$);
      },
    );
  },
);
