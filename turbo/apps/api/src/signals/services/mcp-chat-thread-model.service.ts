import type { McpChatThread } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
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
  memberDefault: string | null,
  orgDefault: string | null,
): McpChatThread["model"] {
  const pinnedModel = selectedModel
    ? (resolved.get(selectedModel) ?? null)
    : null;
  const preferredModel = selectedModel === null ? memberDefault : null;
  return {
    selectedModel,
    effectiveModel: pinnedModel ?? preferredModel ?? orgDefault,
    source: pinnedModel
      ? "thread"
      : preferredModel
        ? "member_default"
        : orgDefault
          ? "org_default"
          : null,
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

  const [preference] = models.has(null)
    ? await db
        .select({ selectedModel: orgMembersMetadata.selectedModel })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, principal.orgId),
            eq(orgMembersMetadata.userId, principal.userId),
          ),
        )
        .limit(1)
    : [];
  const candidateModels = [...models].filter((model) => {
    return model !== null;
  });
  if (preference?.selectedModel) {
    candidateModels.push(preference.selectedModel);
  }
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
  const memberDefault = preference?.selectedModel
    ? (resolved.get(preference.selectedModel) ?? null)
    : null;

  for (const selectedModel of models) {
    result.set(
      selectedModel,
      modelProjection(selectedModel, resolved, memberDefault, orgDefault),
    );
  }
  return result;
}
