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
} from "@okouai/api-contracts/client/agents";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { onboardingStatus$ } from "./okou-page/onboarding.ts";
import { apiClient$ } from "./api-client.ts";
import { discardApiBootstrapResponse } from "./api-client-base.ts";
import { accept } from "../lib/accept.ts";
import { assistantName$ } from "./branding.ts";

export const defaultAgentId$ = computed(async (get) => {
  const status = await get(onboardingStatus$);
  return status.defaultAgentId;
});

const defaultAgent$ = computed(async (get) => {
  const defaultId = await get(defaultAgentId$);
  if (!defaultId) {
    return null;
  }
  const client = get(apiClient$)(agentsByIdContract);
  const result = await accept(client.get({ params: { id: defaultId } }), [200]);
  return result.body;
});

/**
 * The default agent resolves through `defaultAgent$` so callers that address
 * it by id share one request with the default-agent consumers.
 */
export function agentById(id: string): Computed<Promise<AgentResponse>> {
  return computed(async (get) => {
    if (id === (await get(defaultAgentId$))) {
      const defaultAgent = await get(defaultAgent$);
      if (defaultAgent) {
        return defaultAgent;
      }
    }
    const client = get(apiClient$)(agentsByIdContract);
    const result = await accept(client.get({ params: { id } }), [200]);
    return result.body;
  });
}

export const defaultAgentName$ = assistantName$;

export const currentAgentId$ = computed((get) => {
  const route = get(activeRoute$);
  if (route !== "agentChat" && route !== "agentPermissions") {
    return null;
  }

  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

/**
 * The default Agent's new-chat page: `/` under My Okou, otherwise that Agent's
 * own chat page. Home's suggestion list belongs to this page.
 */
export const defaultAgentChatPageActive$ = computed(async (get) => {
  const route = get(activeRoute$);
  if (route === "home") {
    return true;
  }
  const agentId = get(currentAgentId$);
  if (route !== "agentChat" || agentId === null) {
    return false;
  }
  return agentId === (await get(defaultAgentId$));
});

const internalReloadAgents$ = state(0);

/** All visible agents in the user's active organization. */
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const apiClient = get(apiClient$)(agentsMainContract);
  const result = await accept(apiClient.list(), [200]);
  return result.body;
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

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
