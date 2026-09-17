import { createHash } from "node:crypto";

import type { ConnectorSlug } from "../connector-identity";

import type { ConnectorCatalogArtifactConnector } from "./artifacts/artifacts";
import { BUILTIN_FIREWALL_CATALOG_MAX_BYTES } from "./contracts";
import { parseJson } from "./safe";

export const CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION = 2;

export type ConnectorCatalogRuntimeProjectionFallbackReason =
  | "not_ready"
  | "unsupported"
  | "compatibility_not_ready"
  | "invalid_compatibility"
  | "incomplete"
  | "malformed"
  | "digest_mismatch"
  | "unstable";

export interface ConnectorCatalogRuntimeProjectionRowSetIdentity {
  readonly projectionSetId: string;
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly projectionVersion: number;
  readonly connectorCount: number;
}

export interface ConnectorCatalogRuntimeProjectionIdentity extends ConnectorCatalogRuntimeProjectionRowSetIdentity {
  readonly capabilityDigest: string;
}

export interface ConnectorCatalogRuntimeProjectionReadyIdentity {
  readonly identity: ConnectorCatalogRuntimeProjectionIdentity;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

export interface ConnectorCatalogRuntimeProjectionRow {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorDigest: string;
  readonly connectorPayload: Buffer;
}

export type ConnectorCatalogRuntimeProjectionRowsRead =
  | {
      readonly kind: "ready";
      readonly connectors: readonly ConnectorCatalogArtifactConnector[];
      readonly missingConnectorSlugs: readonly ConnectorSlug[];
    }
  | {
      readonly kind: "fallback";
      readonly reason: "malformed" | "digest_mismatch";
    };

export interface ConnectorCatalogRuntimeProjectionValidationTiming {
  measureParse<T>(operation: () => T): T;
  measureDigest<T>(operation: () => T): T;
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
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

export function connectorCatalogRuntimeProjectionPayload(
  connector: ConnectorCatalogArtifactConnector,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(connector)), "utf8");
}

export function connectorCatalogRuntimeProjectionDigest(
  payload: Uint8Array,
): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function connectorCatalogAuthMethodKey(
  connectorSlug: string,
  authMethodId: string,
): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function isAttestedConnectorCatalogRuntimeProjection(
  value: unknown,
  connectorSlug: ConnectorSlug,
): value is ConnectorCatalogArtifactConnector {
  // Exact payload digest plus current package authority establish deep
  // validation; this check only binds the selected row to its connector slug.
  return isUnknownRecord(value) && value.slug === connectorSlug;
}

function parseAttestedConnectorCatalogRuntimeProjection(
  payload: Buffer,
  connectorSlug: ConnectorSlug,
): ConnectorCatalogArtifactConnector | undefined {
  if (
    payload.byteLength === 0 ||
    payload.byteLength > BUILTIN_FIREWALL_CATALOG_MAX_BYTES
  ) {
    return undefined;
  }
  const parsed = parseJson(payload.toString("utf8"));
  return isAttestedConnectorCatalogRuntimeProjection(parsed, connectorSlug)
    ? parsed
    : undefined;
}

function validateAttestedConnectorCatalogRuntimeProjectionRow(args: {
  readonly row: ConnectorCatalogRuntimeProjectionRow;
  readonly timing: ConnectorCatalogRuntimeProjectionValidationTiming;
}):
  | {
      readonly kind: "ready";
      readonly connector: ConnectorCatalogArtifactConnector;
    }
  | {
      readonly kind: "fallback";
      readonly reason: "malformed" | "digest_mismatch";
    } {
  const payload = args.row.connectorPayload;
  const digestMatches = args.timing.measureDigest(() => {
    return (
      connectorCatalogRuntimeProjectionDigest(payload) ===
      args.row.connectorDigest
    );
  });
  if (!digestMatches) {
    return { kind: "fallback", reason: "digest_mismatch" };
  }
  const connector = args.timing.measureParse(() => {
    return parseAttestedConnectorCatalogRuntimeProjection(
      payload,
      args.row.connectorSlug,
    );
  });
  return connector === undefined
    ? { kind: "fallback", reason: "malformed" }
    : { kind: "ready", connector };
}

export function validateConnectorCatalogRuntimeProjectionRows(args: {
  readonly rows: readonly ConnectorCatalogRuntimeProjectionRow[];
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly timing: ConnectorCatalogRuntimeProjectionValidationTiming;
}): ConnectorCatalogRuntimeProjectionRowsRead {
  const rowBySlug = new Map(
    args.rows.map((row) => {
      return [row.connectorSlug, row] as const;
    }),
  );
  const connectors: ConnectorCatalogArtifactConnector[] = [];
  const missingConnectorSlugs: ConnectorSlug[] = [];
  for (const connectorSlug of args.connectorSlugs) {
    const row = rowBySlug.get(connectorSlug);
    if (row === undefined) {
      missingConnectorSlugs.push(connectorSlug);
      continue;
    }
    const validated = validateAttestedConnectorCatalogRuntimeProjectionRow({
      row,
      timing: args.timing,
    });
    if (validated.kind === "fallback") {
      return validated;
    }
    connectors.push(validated.connector);
  }
  return { kind: "ready", connectors, missingConnectorSlugs };
}
