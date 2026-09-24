import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type {
  OrgModelPoliciesResponse,
  UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { apiClient$ } from "../api-client.ts";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { settle } from "../utils.ts";

const internalReloadOrgModelPolicies$ = state(0);

/** One response for the current authenticated user and organization only. */
const orgModelPolicyResource$ = computed(async (get) => {
  const { userId, orgId } = await get(runtimeAuthenticatedIdentity$);
  return {
    identity: { userId, orgId },
    generation: 0,
    lastResolved: undefined as OrgModelPoliciesResponse | undefined,
  };
});

interface UpdateOrgModelPoliciesParams {
  policies: UpdateOrgModelPolicy[];
  revision?: string;
  toast?: boolean;
}

export const orgModelPolicies$ = computed(async (get) => {
  const revision = get(internalReloadOrgModelPolicies$);
  const pendingResource = get(orgModelPolicyResource$);
  const createClient = get(apiClient$);
  const client = createClient(modelPoliciesMainContract, {
    apiBase: "api",
  });
  const resource = await pendingResource;
  const generation = ++resource.generation;
  const result = await settle(accept(client.list(), [200]));
  if (result.ok) {
    // A replaced identity or older pending read must never overwrite the
    // latest snapshot. This resource retains one immutable server response.
    if (
      pendingResource === get(orgModelPolicyResource$) &&
      revision === get(internalReloadOrgModelPolicies$) &&
      generation === resource.generation
    ) {
      resource.lastResolved = result.value.body;
    }
    return result.value.body;
  }
  if (resource.lastResolved !== undefined) {
    // Refresh failures retain the last known UI projection and its original
    // conditional-write revision. Initial failures still surface as errors;
    // admission and writes continue to validate current server state.
    return resource.lastResolved;
  }
  throw result.error;
});

export const invalidateOrgModelPolicies$ = command(({ set }) => {
  set(internalReloadOrgModelPolicies$, (value) => {
    return value + 1;
  });
});

export const refreshOrgModelPolicies$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(invalidateOrgModelPolicies$);
    const response = await get(orgModelPolicies$);
    signal.throwIfAborted();
    return response;
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { get, set },
    params: UpdateOrgModelPoliciesParams,
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);
    const client = createClient(modelPoliciesMainContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.update({
        body: { policies: params.policies, revision: params.revision },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateOrgModelPolicies$);
    if (params.toast !== false) {
      toast.success(
        i18n.t(($) => {
          return $.settings.models.toasts.policiesUpdated;
        }),
      );
    }
    return result.body;
  },
);
