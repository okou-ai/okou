import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
} from "./model-providers";

/**
 * The global model catalog lookups configurability reads. The API adapts its
 * loaded catalog snapshot; the Platform catalog view satisfies it directly.
 */
export interface MemberModelPolicyCatalog {
  /** The active model a stored selection resolves to; undefined when unknown. */
  resolve(model: string): string | undefined;
  /** Enabled routes of a model for one selected provider route type. */
  routes(
    model: string,
    query: { readonly providerType: string },
  ): readonly unknown[];
}

/** Whether the catalog has an enabled route of this provider type for the model. */
function hasCatalogProviderRoute(
  catalog: MemberModelPolicyCatalog,
  model: string,
  providerType: string,
): boolean {
  const resolved = catalog.resolve(model);
  return (
    resolved !== undefined &&
    catalog.routes(resolved, {
      providerType: isBuiltInModelProviderType(providerType)
        ? "built-in"
        : providerType,
    }).length > 0
  );
}

/** Response-only member view. Never serialize this as an administrative policy. */
export function getMemberModelPolicyRoute(policy: OrgModelPolicy) {
  if (policy.memberEffective) {
    return policy.memberEffective;
  }
  // Older APIs and Priority-off responses only expose the administrative route.
  // In particular, a legacy member route remains a subscription until conversion.
  // #34010 owns removal after the C API serving/rollback and switch gates close.
  return {
    providerType: policy.defaultProviderType,
    runtimeProviderType: isBuiltInModelProviderType(policy.defaultProviderType)
      ? policy.runtimeProviderType
      : policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    availability: policy.routeStatus === "valid" ? "available" : "unavailable",
    accountSelection:
      policy.credentialScope === "member"
        ? "capture_required"
        : "not_applicable",
  } as const;
}

/** Local candidate only: run admission still captures credentials and quota can fail. */
export function isMemberModelPolicyAvailable(policy: OrgModelPolicy): boolean {
  return getMemberModelPolicyRoute(policy).availability === "available";
}

/**
 * A missing/reconnecting subscription stays selectable so its owner can
 * connect it, when the catalog has an enabled route of that provider type for
 * the model. Without a loaded catalog there is no route evidence for it.
 */
export function isMemberModelPolicyConfigurable(
  policy: OrgModelPolicy,
  catalog: MemberModelPolicyCatalog | null | undefined,
): boolean {
  if (!policy.memberEffective) {
    return policy.routeStatus === "valid";
  }
  const route = getMemberModelPolicyRoute(policy);
  return (
    route.availability === "available" ||
    route.availability === "reconnect_required" ||
    (route.availability === "unavailable" &&
      route.credentialScope === "member" &&
      !!catalog &&
      hasCatalogProviderRoute(catalog, policy.model, route.providerType))
  );
}
