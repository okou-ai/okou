import { command, computed, state } from "ccstate";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { composerAgentConnectorsChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";

const revisions$ = state<ReadonlyMap<string, number>>(new Map());

export const invalidateAgentConnectorAccess$ = command(
  ({ set }, agentId: string) => {
    set(revisions$, (current) => {
      const next = new Map(current);
      next.set(agentId, (current.get(agentId) ?? 0) + 1);
      return next;
    });
  },
);

export function composerAgentConnectors(agentId: string) {
  return computed(async (get) => {
    get(revisions$).get(agentId);
    const createClient = get(apiClient$);
    const result = await accept(
      createClient(connectorOverviewContract).agent({
        params: { id: agentId },
      }),
      [200, 404],
    );
    if (result.status === 200) {
      return result.body;
    }

    // A newly promoted App may reach an older API during rollout or rollback.
    // Remove this bridge after those API versions leave serving and rollback.
    const [builtin, custom] = await Promise.all([
      accept(
        createClient(userBuiltinConnectorsContract).get({
          params: { id: agentId },
        }),
        [200],
      ),
      accept(
        createClient(agentCustomConnectorsContract).get({
          params: { id: agentId },
        }),
        [200],
      ),
    ]);
    return {
      enabledConnectorSlugs: builtin.body.enabledConnectorSlugs,
      customConnectorIds: custom.body.grants.map((grant) => {
        return grant.customConnectorId;
      }),
    };
  });
}

const reloadFromRealtime$ = command(({ set }, payload: unknown): boolean => {
  const parsed = composerAgentConnectorsChangedPayloadSchema.safeParse(payload);
  if (parsed.success) {
    set(invalidateAgentConnectorAccess$, parsed.data.agentId);
  }
  return false;
});

export const subscribeAgentConnectorAccess$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "composerAgentConnectorsChanged",
        loopCommand$: reloadFromRealtime$,
      },
      signal,
    );
  },
);
