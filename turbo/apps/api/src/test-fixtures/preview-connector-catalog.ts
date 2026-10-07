import { createHash } from "node:crypto";

import {
  connectorCatalogArtifactConnectorSchema,
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";

export function previewCatalogExtraSlug(index: number): string {
  return `preview-catalog-${index}`;
}

export function previewCatalogBundledSkill(
  slug: string,
  versionSeed = slug,
): Extract<ConnectorCatalogArtifactConnector["skill"], { kind: "bundled" }> {
  const storageName = `connector-skill@${slug}`;
  const versionId = createHash("sha256").update(versionSeed).digest("hex");
  return {
    kind: "bundled",
    storageName,
    versionId,
    storageVersionPrefix: `__system__/volume/${storageName}/${versionId}`,
    size: 64,
    archiveSize: 64,
    fileCount: 1,
  };
}

/**
 * External publisher fixture: the API test catalog plus `extraCount` ordinary
 * manual-token HTTP connectors, each with its own firewall host and bundled
 * skill.
 */
export function previewConnectorCatalogFixture(
  extraCount = 1,
): ConnectorCatalogArtifact {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  const template = artifact.connectors.find((entry) => {
    return entry.slug === "gitlab";
  });
  if (!template || template.firewall.kind !== "generated") {
    throw new Error("Missing manual-token publisher fixture");
  }
  const templateJson = JSON.stringify(template);
  for (let index = 0; index < extraCount; index++) {
    const slug = previewCatalogExtraSlug(index);
    // Each connector owns its storage secret and variable names.
    const connector = connectorCatalogArtifactConnectorSchema.parse(
      JSON.parse(
        templateJson.replaceAll("GITLAB_", `PREVIEW_CATALOG_${index}_`),
      ),
    );
    if (connector.firewall.kind !== "generated") {
      throw new Error("Expected a generated firewall");
    }
    const firewall = connector.firewall;
    artifact.connectors.push({
      ...connector,
      slug,
      label: `Preview Catalog ${index}`,
      skill: previewCatalogBundledSkill(slug),
      firewall: {
        ...firewall,
        config: {
          ...firewall.config,
          description: `Preview Catalog ${index}`,
          apis: firewall.config.apis.map((api, apiIndex) => {
            return {
              ...api,
              base: `https://${slug}-${apiIndex}.example.test/api`,
            };
          }),
        },
      },
    });
  }
  return artifact;
}
