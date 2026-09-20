import { command, computed, state } from "ccstate";
import { accept } from "../lib/accept.ts";
import { agents$, currentAgent$ } from "./agent.ts";
import {
  vncClients$,
  vncIdentity$,
  vncSummary$,
  invalidateVnc$,
} from "./vnc.ts";

export const currentAgentVncAccess$ = computed(async (get) => {
  const identity = await get(vncIdentity$);
  if (!identity) {
    return null;
  }
  const [agent, summary] = await Promise.all([
    get(currentAgent$),
    get(vncSummary$),
  ]);
  if (!agent || !summary || summary.configuredCount === 0) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).access.get({ params: { agentId: agent.agentId } }),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200
    ? { identity, agentId: agent.agentId, ...result.body }
    : null;
});

export const updateAgentVncAccess$ = command(
  async (
    { get, set },
    agentId: string,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const clients = await get(vncClients$);
    signal.throwIfAborted();
    const [summary, visibleAgents] = await Promise.all([
      get(vncSummary$),
      get(agents$),
    ]);
    signal.throwIfAborted();
    if (
      !summary ||
      summary.configuredCount === 0 ||
      !visibleAgents.some((agent) => {
        return agent.agentId === agentId;
      }) ||
      clients.identity !== (await get(vncIdentity$))
    ) {
      return;
    }
    signal.throwIfAborted();
    await accept(
      clients.access.update({
        params: { agentId },
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (clients.identity !== (await get(vncIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(invalidateVnc$);
  },
);

export const vncAgentAccessRows$ = computed(async (get) => {
  const summary = await get(vncSummary$);
  if (!summary) {
    return null;
  }
  if (summary.configuredCount === 0) {
    return [];
  }
  const [visibleAgents, clients] = await Promise.all([
    get(agents$),
    get(vncClients$),
  ]);
  const rows = await Promise.all(
    visibleAgents.map(async (agent) => {
      const result = await accept(
        clients.access.get({ params: { agentId: agent.agentId } }),
        [200, 404],
        undefined,
        { showErrorToast: false },
      );
      return result.status === 200
        ? { agent, enabled: result.body.enabled }
        : null;
    }),
  );
  return rows.filter((row) => {
    return row !== null;
  });
});

export const vncAgentAccessSnapshot$ = computed(async (get) => {
  const [identity, rows] = await Promise.all([
    get(vncIdentity$),
    get(vncAgentAccessRows$),
  ]);
  return { identity, rows };
});

const accessManagementIdentity$ = state<string | null>(null);
const accessSearch$ = state("");
export const vncAccessSearch$ = computed((get) => {
  return get(accessSearch$);
});
export const searchVncAccess$ = command(({ set }, value: string) => {
  set(accessSearch$, value);
});
export const vncAccessManagementOpen$ = computed(async (get) => {
  const identity = get(accessManagementIdentity$);
  return identity !== null && identity === (await get(vncIdentity$));
});
export const closeVncAccessManagement$ = command(({ set }) => {
  set(accessManagementIdentity$, null);
  set(accessSearch$, "");
});
export const openVncAccessManagement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const identity = await get(vncIdentity$);
    signal.throwIfAborted();
    set(accessManagementIdentity$, identity);
    set(accessSearch$, "");
    set(invalidateVnc$);
  },
);
