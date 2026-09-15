import {
  isBuiltInModelProviderType,
  isModelSupportedByProvider,
  type OrgModelPolicy,
} from "./model-providers";

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

/** A missing/reconnecting subscription stays selectable so its owner can connect it. */
export function isMemberModelPolicyConfigurable(
  policy: OrgModelPolicy,
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
      isModelSupportedByProvider(policy.model, route.providerType))
  );
}
