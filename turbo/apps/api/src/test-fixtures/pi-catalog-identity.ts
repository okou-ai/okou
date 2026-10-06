import { createHash } from "node:crypto";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";
import { connectorCatalogExecutableCapabilityState } from "../signals/services/connector-catalog-compatibility.service";

function canonicalFixtureJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFixtureJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => {
        return item !== undefined;
      })
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      })
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${canonicalFixtureJson(item)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Encode historical bytes without asserting them as the current source contract. */
export function historicalPiArtifactForTest(projection: unknown) {
  return {
    json: JSON.stringify(projection),
    digest: createHash("sha256")
      .update(canonicalFixtureJson({ kind: "pi-stable-context", projection }))
      .digest("hex"),
  };
}

/** Identity of actual serialized fixture bytes; unsupported schemas are negative cases. */
export function piCatalogIdentityForTest(
  schemaVersion: number = API_TEST_CONNECTOR_CATALOG_ARTIFACT.artifactSchemaVersion,
  catalogVersion = API_TEST_CONNECTOR_CATALOG_ARTIFACT.catalogVersion,
) {
  const bytes = JSON.stringify({
    ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
    artifactSchemaVersion: schemaVersion,
    catalogVersion,
  });
  return {
    schemaVersion,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    capabilityDigest: connectorCatalogExecutableCapabilityState().digest,
  };
}
