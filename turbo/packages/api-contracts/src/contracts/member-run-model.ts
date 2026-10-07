import {
  isBuiltInModelProviderType,
  type AvailableRunModel,
} from "./model-providers";

export function getMemberRunModelRoute(model: AvailableRunModel) {
  if (model.memberEffective) {
    return model.memberEffective;
  }
  return {
    providerType: model.defaultProviderType,
    runtimeProviderType: isBuiltInModelProviderType(model.defaultProviderType)
      ? model.runtimeProviderType
      : model.defaultProviderType,
    credentialScope: model.credentialScope,
    availability: "available",
    accountSelection:
      model.credentialScope === "member"
        ? "capture_required"
        : "not_applicable",
  } as const;
}

export function isMemberRunModelAvailable(model: AvailableRunModel): boolean {
  return getMemberRunModelRoute(model).availability === "available";
}

export function isMemberRunModelConfigurable(
  model: AvailableRunModel,
): boolean {
  const { availability } = getMemberRunModelRoute(model);
  return availability === "available" || availability === "reconnect_required";
}
