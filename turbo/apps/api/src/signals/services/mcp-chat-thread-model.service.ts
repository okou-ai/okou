import type { McpChatThread } from "@okouai/api-contracts/contracts/mcp-chat-threads";

import type { Db } from "../external/db";
import {
  loadMemberModelRouteContext,
  resolveEffectivePolicyRoute,
} from "./effective-model-route.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { resolveCatalogRunModel } from "./model-catalog.service";
import { loadOrgModelPolicyFacts } from "./model-policy.service";

function modelProjection(
  selectedModel: string | null,
  finalModel: string | null,
  resolved: ReadonlyMap<string, string | null>,
  orgDefault: string | null,
): McpChatThread["model"] {
  const pinnedModel = finalModel ? (resolved.get(finalModel) ?? null) : null;
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

  const { policies: projectedPolicies, catalog } =
    await loadOrgModelPolicyFacts(db, principal.orgId);
  // Stored pins resolve along the catalog replacement chain.
  const finalModels = new Map<string, string | null>();
  for (const model of models) {
    if (model !== null) {
      finalModels.set(model, resolveCatalogRunModel(catalog, model));
    }
  }
  const candidateModels = new Set<string>([
    catalog.systemDefaultModel,
    ...[...finalModels.values()].filter((model): model is string => {
      return model !== null;
    }),
  ]);
  const policies = projectedPolicies.filter((policy) => {
    return candidateModels.has(policy.model);
  });
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
      catalog,
      orgId: principal.orgId,
      member,
      capabilities: routeCapabilities,
      policy,
    });
    resolved.set(policy.model, route?.selectedModel ?? null);
  }
  const orgDefault = resolved.get(catalog.systemDefaultModel) ?? null;

  for (const selectedModel of models) {
    const finalModel =
      selectedModel === null ? null : (finalModels.get(selectedModel) ?? null);
    result.set(
      selectedModel,
      modelProjection(selectedModel, finalModel, resolved, orgDefault),
    );
  }
  return result;
}
