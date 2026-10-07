import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
} from "@okouai/api-contracts/contracts/onboarding";
import { connectorCatalogArtifactSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";

/** External publisher fixture; unrelated entries exercise bounded installation. */
export function previewOnboardingCatalogFixture(extraCount = 1) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  const required = new Set([
    ...ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
    ...ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
    "algolia",
    "bentoml",
    "discord-webhook",
    "replicate",
    "serpapi",
    "twilio",
    "zendesk",
  ]);
  const template = artifact.connectors.find((entry) => {
    return entry.slug === "public-mcp";
  });
  if (!template) {
    throw new Error("Missing anonymous publisher fixture");
  }
  for (const slug of required) {
    if (
      !artifact.connectors.some((entry) => {
        return entry.slug === slug;
      })
    ) {
      artifact.connectors.push({
        ...structuredClone(template),
        slug,
        label: slug,
      });
    }
  }
  for (let index = 0; index < extraCount; index++) {
    const slug = `preview-unrelated-${index}`;
    artifact.connectors.push({
      ...structuredClone(template),
      slug,
      label: slug,
    });
  }
  return artifact;
}
