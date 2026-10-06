import { getMemberRunModelRoute } from "@okouai/api-contracts/contracts/member-run-model";
import {
  getModelProviderPresentationLabel,
  isBuiltInModelProviderType,
  type AvailableRunModel,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";

type ModelProviderRouteKind = "built-in" | "subscription";

export function getModelProviderRouteKind(
  runModel: AvailableRunModel,
): ModelProviderRouteKind {
  const route = getMemberRunModelRoute(runModel);
  if (isBuiltInModelProviderType(route.providerType)) {
    return "built-in";
  }

  return "subscription";
}

export function getModelProviderTypeLabel(type: ModelProviderType): string {
  return getModelProviderPresentationLabel(type);
}

export function formatModelProviderRoute(runModel: AvailableRunModel): string {
  const kind = getModelProviderRouteKind(runModel);
  const route = getMemberRunModelRoute(runModel);
  const label = getModelProviderTypeLabel(route.providerType);
  return `${kind} (${label}; ${route.providerType})`;
}

export function formatRunModelStatus(
  runModel: AvailableRunModel,
): string | null {
  if (runModel.memberEffective) {
    switch (runModel.memberEffective.availability) {
      case "available":
        return null;
      case "reconnect_required":
        return "reconnect_required: Reconnect your personal subscription in Preferences / Personal Models.";
      case "plan_restricted":
        return "plan_restricted: Review your organization's plan in Billing.";
      case "unavailable":
        return runModel.memberEffective.credentialScope === "member"
          ? "unavailable: Connect your personal subscription in Preferences / Personal Models."
          : "unavailable: Auto is unavailable. Try again later.";
    }
  }
  if (runModel.routeStatus === "valid") {
    return null;
  }

  return runModel.routeStatusReason
    ? `${runModel.routeStatus}: ${runModel.routeStatusReason}`
    : runModel.routeStatus;
}
