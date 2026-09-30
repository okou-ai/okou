import type { McpChatThread } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { and, eq, inArray, or } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  loadMemberModelRouteContext,
  resolveEffectivePolicyRoute,
} from "./effective-model-route.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

function modelProjection(
  selectedModel: string | null,
  resolved: ReadonlyMap<string, string | null>,
  orgDefault: string | null,
): McpChatThread["model"] {
  const pinnedModel = selectedModel
    ? (resolved.get(selectedModel) ?? null)
    : null;
  return {
    selectedModel,
    effectiveModel: pinnedModel ?? orgDefault,
    source: pinnedModel ? "thread" : orgDefault ? "org_default" : null,
    admission: "checked_on_send",
  };
}

/** Project current policy without seeding policies, reconciling pins, or admission. */
export async function mcpChatThreadModels(
  db: Db,
  principal: { readonly userId: string; readonly orgId: string },
  selectedModels: readonly (string | null)[],
): Promise<ReadonlyMap<string | null, McpChatThread["model"]>> {
  const models = new Set(selectedModels);
  const result = new Map<string | null, McpChatThread["model"]>();
  if (models.size === 0) {
    return result;
  }

  const candidateModels = [...models].filter((model) => {
    return model !== null;
  });
  const policies = await db
    .select({
      model: orgModelPolicies.model,
      isDefault: orgModelPolicies.isDefault,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
      modelProviderSurfaceId: orgModelPolicies.modelProviderSurfaceId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, principal.orgId),
        or(
          eq(orgModelPolicies.isDefault, true),
          candidateModels.length > 0
            ? inArray(orgModelPolicies.model, candidateModels)
            : undefined,
        ),
      ),
    );
  const capabilities = await loadOrgPlanCapabilities(db, principal.orgId);
  const member = await loadMemberModelRouteContext(
    db,
    principal.orgId,
    principal.userId,
  );
  // Match model-selection.service's policy projection. Run admission independently
  // checks plan status; this response never claims that a run can start.
  const routeCapabilities =
    capabilities?.status === "active"
      ? {
          restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
          supportByok: capabilities.supportByok,
        }
      : { restrictedBuiltInModels: false, supportByok: true };
  const resolved = new Map<string, string | null>();
  for (const policy of policies) {
    const route = await resolveEffectivePolicyRoute({
      db,
      orgId: principal.orgId,
      member,
      capabilities: routeCapabilities,
      policy,
    });
    resolved.set(policy.model, route?.selectedModel ?? null);
  }
  const defaultPolicy = policies.find((policy) => {
    return policy.isDefault;
  });
  const orgDefault = defaultPolicy
    ? (resolved.get(defaultPolicy.model) ?? null)
    : null;

  for (const selectedModel of models) {
    result.set(
      selectedModel,
      modelProjection(selectedModel, resolved, orgDefault),
    );
  }
  return result;
}
