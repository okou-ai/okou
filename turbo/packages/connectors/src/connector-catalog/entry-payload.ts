import type { ConnectorCatalogArtifactConnector } from "./artifacts/artifacts";

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON object ordering across publication bytes and JSONB reads. */
export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (!isUnknownRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        return [key, canonicalJsonValue(value[key])];
      }),
  );
}

/** Stable byte comparison for already prepared immutable entry payloads. */
export function connectorCatalogEntryPayload(
  connector: ConnectorCatalogArtifactConnector,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(connector)), "utf8");
}
