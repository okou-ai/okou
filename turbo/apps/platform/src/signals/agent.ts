/**
 * Fundamental agent signals used across the platform.
 *
 * This file is the single source of truth for agent identity, lists,
 * metadata, and avatar signals. Downstream code should import from here
 * instead of reaching into individual signal files.
 */
import { command, computed, type Computed, state } from "ccstate";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { onboardingStatus$ } from "./okou-page/onboarding.ts";
import { apiClient$ } from "./api-client.ts";
import { discardApiBootstrapResponse } from "./api-client-base.ts";
import { accept } from "../lib/accept.ts";
import { retryTransientLoad } from "./utils.ts";
import { assistantName$ } from "./branding.ts";

export const defaultAgentId$ = computed(async (get) => {
  const status = await get(onboardingStatus$);
  return status.defaultAgentId;
});

const internalAgentByIdReload$ = state(0);

export function agentById(id: string): Computed<Promise<AgentResponse>> {
  return computed(async (get) => {
    get(internalAgentByIdReload$);
    const client = get(apiClient$)(agentsByIdContract);
    const result = await retryTransientLoad(() => {
      return accept(client.get({ params: { id } }), [200]);
    });
    return result.body;
  });
}

export const reloadAgentById$ = command(({ set }) => {
  set(internalAgentByIdReload$, (prev) => {
    return prev + 1;
  });
});

const defaultAgent$ = computed(async (get) => {
  const defaultId = await get(defaultAgentId$);
  if (!defaultId) {
    return null;
  }
  return get(agentById(defaultId));
});

export const defaultAgentName$ = computed(async (get) => {
  const defaultAgent = await get(defaultAgent$);
  return defaultAgent?.displayName ?? get(assistantName$);
});

export const currentAgentId$ = computed((get) => {
  const route = get(activeRoute$);
  if (
    route !== "agentDetail" &&
    route !== "agentChat" &&
    route !== "agentIdeas" &&
    route !== "agentPermissions"
  ) {
    return null;
  }

  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

export const currentAgent$ = computed((get) => {
  const agentId = get(currentAgentId$);
  if (!agentId) {
    return null;
  }
  return get(agentById(agentId));
});

const internalReloadAgents$ = state(0);

/** All visible agents in the user's active organization. */
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const apiClient = get(apiClient$)(agentsMainContract);
  const result = await accept(apiClient.list(), [200]);
  return result.body;
});

export const sortedAgents$ = computed(async (get) => {
  const agents = await get(agents$);
  const defaultId = await get(defaultAgentId$);
  return [
    ...agents.filter((a) => {
      return a.agentId === defaultId;
    }),
    ...agents.filter((a) => {
      return a.agentId !== defaultId;
    }),
  ];
});

/** Bump to refetch the agents list. */
export const reloadAgents$ = command(({ set }) => {
  discardApiBootstrapResponse(
    agentsMainContract.list.method,
    agentsMainContract.list.path,
  );
  set(internalReloadAgents$, (prev) => {
    return prev + 1;
  });
});

/** Non-default agents. */
export const subagents$ = computed(async (get) => {
  const all = await get(agents$);
  const defaultId = await get(defaultAgentId$);
  return all.filter((a) => {
    return a.agentId !== defaultId;
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface SubagentInfo {
  agentId: string;
  displayName?: string | null;
}
