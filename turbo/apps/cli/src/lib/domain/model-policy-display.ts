import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import {
  getModelProviderPresentationLabel,
  isBuiltInModelProviderType,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";

type ModelProviderRouteKind = "built-in" | "api key" | "subscription";

export function getModelProviderRouteKind(
  policy: OrgModelPolicy,
): ModelProviderRouteKind {
  const route = getMemberModelPolicyRoute(policy);
  if (isBuiltInModelProviderType(route.providerType)) {
    return "built-in";
  }

  if (route.credentialScope === "member") {
    return "subscription";
  }

  return "api key";
}

export function getModelProviderTypeLabel(type: ModelProviderType): string {
  return getModelProviderPresentationLabel(type);
}

export function formatModelProviderRoute(policy: OrgModelPolicy): string {
  const kind = getModelProviderRouteKind(policy);
  const route = getMemberModelPolicyRoute(policy);
  const label = getModelProviderTypeLabel(route.providerType);
  return `${kind} (${label}; ${route.providerType})`;
}

export function formatModelPolicyStatus(policy: OrgModelPolicy): string | null {
  if (policy.memberEffective) {
    switch (policy.memberEffective.availability) {
      case "available":
        return null;
      case "reconnect_required":
        return "reconnect_required: Reconnect your personal subscription in Preferences / Personal Models.";
      case "plan_restricted":
        return "plan_restricted: Review your organization's plan in Billing.";
      case "unavailable":
        return policy.memberEffective.credentialScope === "member"
          ? "unavailable: Connect your personal subscription in Preferences / Personal Models."
          : "unavailable: Ask an organization admin to review this model provider.";
    }
  }
  if (policy.routeStatus === "valid") {
    return null;
  }

  return policy.routeStatusReason
    ? `${policy.routeStatus}: ${policy.routeStatusReason}`
    : policy.routeStatus;
}
