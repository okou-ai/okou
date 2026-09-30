import { normalizeRunModelId, type ModelProviderType } from "./model-providers";

/**
 * A policy explicitly binds its catalog model to one saved cloud deployment.
 * `catalogRouteEnabled` is whether the catalog has an enabled route of this
 * cloud provider type for the model (`model_routes`); a model without one is
 * never mapped. `catalogModels` is the global model catalog: an Azure
 * deployment named after a different catalog model is rejected so that one
 * model's policy never silently runs another catalog model.
 */
export function isCloudModelMappingValid(
  type: ModelProviderType,
  catalogModel: string,
  configuredModel: string | null,
  catalogRouteEnabled: boolean,
  catalogModels: { has(model: string): boolean },
): boolean {
  if (type !== "azure-foundry" && type !== "aws-bedrock") return true;
  if (!catalogRouteEnabled || !configuredModel) return false;
  if (type === "azure-foundry") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u.test(configuredModel))
      return false;
    const upstreamCatalogModel = normalizeRunModelId(configuredModel);
    return (
      !catalogModels.has(upstreamCatalogModel) ||
      upstreamCatalogModel === catalogModel
    );
  }
  // Opaque application/inference profiles require the explicit policy binding;
  // the native config separately verifies that the ARN matches the region.
  if (
    /^arn:aws:bedrock:[a-z0-9-]+:\d{12}:(?:application-inference-profile|inference-profile)\/[a-zA-Z0-9:._/-]+$/u.test(
      configuredModel,
    )
  )
    return true;
  const foundationModel =
    /^(?:(?:us|eu|apac|global)\.)?anthropic\.(claude-[a-z0-9-]+)(?::\d+)?$/u.exec(
      configuredModel,
    )?.[1];
  return (
    foundationModel !== undefined &&
    (foundationModel === catalogModel ||
      foundationModel.startsWith(`${catalogModel}-`))
  );
}
