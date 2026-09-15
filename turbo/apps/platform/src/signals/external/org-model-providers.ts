import { command, computed, state } from "ccstate";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import type { UpsertModelProviderRequest } from "@okouai/api-contracts/contracts/model-providers";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { invalidateOrgModelPolicies$ } from "./org-model-policies.ts";

/**
 * Reload trigger for org model provider signals.
 * Increment to force recomputation of orgModelProviders$.
 */
const internalReloadOrgModelProviders$ = state(0);

/**
 * Org-level model providers.
 */
export const orgModelProviders$ = computed(async (get) => {
  get(internalReloadOrgModelProviders$);
  const createClient = get(apiClient$);
  const client = createClient(modelProvidersMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Create or update an org model provider (admin only).
 */
export const createOrgModelProvider$ = command(
  async (
    { get, set },
    request: UpsertModelProviderRequest,
    _signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);
    const client = createClient(modelProvidersMainContract);
    const result = await accept(
      client.upsert({
        body: request,
        fetchOptions: { signal: _signal },
      }),
      [200, 201],
    );

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });
    set(invalidateOrgModelPolicies$);

    return result.body;
  },
);

/**
 * Force a refetch of `orgModelProviders$`. Used by higher-level commands
 * that mutate provider state through a different code path, such as Codex
 * device login.
 */
export const reloadOrgModelProviders$ = command(({ set }) => {
  set(invalidateOrgModelPolicies$);
  set(internalReloadOrgModelProviders$, (x) => {
    return x + 1;
  });
});
