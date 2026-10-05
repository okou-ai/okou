import {
  isBuiltInModelProviderType,
  type AvailableRunModel,
} from "./model-providers";

export interface MemberRunModelCatalog {
  resolve(model: string): string | undefined;
  routes(
    model: string,
    query: { readonly providerType: string },
  ): readonly unknown[];
}

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
    availability: model.routeStatus === "valid" ? "available" : "unavailable",
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
  catalog: MemberRunModelCatalog | null | undefined,
): boolean {
  const route = getMemberRunModelRoute(model);
  const resolved = catalog?.resolve(model.model);
  return (
    route.availability === "available" ||
    route.availability === "reconnect_required" ||
    (route.availability === "unavailable" &&
      route.credentialScope === "member" &&
      resolved !== undefined &&
      !!catalog &&
      catalog.routes(resolved, { providerType: route.providerType }).length > 0)
  );
}
