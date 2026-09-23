import { command, computed, state } from "ccstate";
import { composerConnectorsContract } from "@okouai/api-contracts/contracts/composer-connectors";
import { composerAgentConnectorsChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";

const revisions$ = state<ReadonlyMap<string, number>>(new Map());

export const invalidateComposerAgentConnectors$ = command(
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
    const result = await accept(
      get(apiClient$)(composerConnectorsContract).agent({
        params: { id: agentId },
      }),
      [200],
    );
    return result.body;
  });
}

const reloadFromRealtime$ = command(({ set }, payload: unknown): boolean => {
  const parsed = composerAgentConnectorsChangedPayloadSchema.safeParse(payload);
  if (parsed.success) {
    set(invalidateComposerAgentConnectors$, parsed.data.agentId);
  }
  return false;
});

export const subscribeComposerAgentConnectors$ = command(
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
