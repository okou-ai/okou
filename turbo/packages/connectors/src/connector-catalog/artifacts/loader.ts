import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import {
  CONNECTOR_CATALOG_MAX_RAW_BYTES,
  type ConnectorCatalogValidationFailureCode,
} from "../contracts";
import { attempt, parseJson } from "../safe";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "./artifacts";
import {
  connectorCatalogVersionSchema,
  artifactKeySchema,
  digestSchema,
} from "./common";
import { validateConnectorCatalogPublicProjection } from "./public-leak";
import { validateConnectorCatalogArtifact } from "./relationships";
import {
  ConnectorCatalogRelationshipError,
  type ConnectorCatalogRelationshipRule,
} from "./relationship-error";

const ACTIVE_POINTER_MAX_BYTES = 16 * 1024;
const CONNECTOR_CATALOG_MAX_GZIP_BYTES = CONNECTOR_CATALOG_MAX_RAW_BYTES * 2;

export type ConnectorCatalogValidationTimingAction =
  | "api_dispatch_connector_catalog_decompress"
  | "api_dispatch_connector_catalog_verify_digest"
  | "api_dispatch_connector_catalog_decode_json"
  | "api_dispatch_connector_catalog_validate_schema"
  | "api_dispatch_connector_catalog_validate_public_projection"
  | "api_dispatch_connector_catalog_validate_relationships";

export interface ConnectorCatalogValidationTiming {
  measureSync<T>(
    actionType: ConnectorCatalogValidationTimingAction,
    operation: () => T,
  ): T;
}

const connectorCatalogObjectKeySchema = artifactKeySchema.refine((key) => {
  const namespace = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/`;
  return (
    key.startsWith(namespace) &&
    key !== CONNECTOR_CATALOG_ACTIVE_KEY &&
    key.endsWith(".json") &&
    !key.includes("?") &&
    !key.includes("#")
  );
}, "Catalog key must be a trusted connector JSON object key");

const connectorCatalogActivePointerSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    catalogKey: connectorCatalogObjectKeySchema,
    catalogDigest: digestSchema,
  })
  .strict();

export type ConnectorCatalogActivePointer = z.infer<
  typeof connectorCatalogActivePointerSchema
>;

export interface ConnectorCatalogIdentity {
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogKey: string;
  readonly catalogDigest: string;
}

export interface ValidatedConnectorCatalogCandidate {
  readonly identity: ConnectorCatalogIdentity;
  readonly artifact: ConnectorCatalogArtifact;
  readonly rawBytes: Buffer;
}

interface DecodedConnectorCatalogSnapshot {
  readonly artifact: ConnectorCatalogArtifact;
}

export interface ConnectorCatalogArtifactReader {
  readArtifact(key: string, maxBytes: number): Promise<Uint8Array>;
}

class ConnectorCatalogArtifactError extends Error {
  constructor(
    readonly code: ConnectorCatalogValidationFailureCode,
    readonly relationshipRule?: ConnectorCatalogRelationshipRule,
  ) {
    super(code);
    this.name = "ConnectorCatalogArtifactError";
  }
}

export function connectorCatalogArtifactFailureCode(
  value: unknown,
): ConnectorCatalogValidationFailureCode | undefined {
  return value instanceof ConnectorCatalogArtifactError
    ? value.code
    : undefined;
}

export function connectorCatalogArtifactRelationshipRule(
  value: unknown,
): ConnectorCatalogRelationshipRule | undefined {
  return value instanceof ConnectorCatalogArtifactError
    ? value.relationshipRule
    : undefined;
}

function fail(
  code: ConnectorCatalogValidationFailureCode,
  relationshipRule?: ConnectorCatalogRelationshipRule,
): never {
  throw new ConnectorCatalogArtifactError(code, relationshipRule);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectorCatalogDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertDigest(bytes: Uint8Array, expectedDigest: string): void {
  if (connectorCatalogDigest(bytes) !== expectedDigest) {
    fail("digest-mismatch");
  }
}

async function readBoundedArtifact(
  reader: ConnectorCatalogArtifactReader,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const bytes = Buffer.from(await reader.readArtifact(key, maxBytes));
  if (bytes.length > maxBytes) {
    fail("object-too-large");
  }
  return bytes;
}

function decodedJson(bytes: Uint8Array): unknown {
  const decoded = attempt(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
  if (!("ok" in decoded)) {
    fail("invalid-json");
  }
  const value = parseJson(decoded.ok);
  if (value === undefined) {
    fail("invalid-json");
  }
  return value;
}

function parseStrict<T>(
  value: unknown,
  schema: z.ZodType<T>,
  code: ConnectorCatalogValidationFailureCode,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    fail(code);
  }
  return parsed.data;
}

function assertSupportedArtifactSchema(value: unknown): void {
  if (
    isRecord(value) &&
    typeof value.artifactSchemaVersion === "number" &&
    value.artifactSchemaVersion !== SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION
  ) {
    fail("unsupported-schema");
  }
}

function measureSnapshotPhase<T>(
  timing: ConnectorCatalogValidationTiming | undefined,
  actionType: ConnectorCatalogValidationTimingAction,
  operation: () => T,
): T {
  return timing ? timing.measureSync(actionType, operation) : operation();
}

function validateCatalogJson(args: {
  readonly json: unknown;
  readonly catalogVersion: string;
  readonly timing?: ConnectorCatalogValidationTiming;
}): ConnectorCatalogArtifact {
  const artifact = measureSnapshotPhase(
    args.timing,
    "api_dispatch_connector_catalog_validate_schema",
    () => {
      assertSupportedArtifactSchema(args.json);
      const parsed = parseStrict(
        args.json,
        connectorCatalogArtifactSchema,
        "invalid-artifact",
      );
      if (parsed.catalogVersion !== args.catalogVersion) {
        fail("invalid-reference");
      }
      return parsed;
    },
  );
  measureSnapshotPhase(
    args.timing,
    "api_dispatch_connector_catalog_validate_public_projection",
    () => {
      const publicProjection = attempt(() => {
        validateConnectorCatalogPublicProjection(artifact);
      });
      if (!("ok" in publicProjection)) {
        fail("public-leakage");
      }
    },
  );
  measureSnapshotPhase(
    args.timing,
    "api_dispatch_connector_catalog_validate_relationships",
    () => {
      const relationships = attempt(() => {
        validateConnectorCatalogArtifact(artifact);
      });
      if (!("ok" in relationships)) {
        fail(
          "relationship-mismatch",
          relationships.error instanceof ConnectorCatalogRelationshipError
            ? relationships.error.rule
            : undefined,
        );
      }
    },
  );
  return artifact;
}

function decodeCatalogJson(
  bytes: Uint8Array,
  timing: ConnectorCatalogValidationTiming | undefined,
): unknown {
  return measureSnapshotPhase(
    timing,
    "api_dispatch_connector_catalog_decode_json",
    () => {
      return decodedJson(bytes);
    },
  );
}

function parseAndValidateCatalog(args: {
  readonly bytes: Uint8Array;
  readonly catalogVersion: string;
  readonly timing?: ConnectorCatalogValidationTiming;
}): ConnectorCatalogArtifact {
  return validateCatalogJson({
    json: decodeCatalogJson(args.bytes, args.timing),
    catalogVersion: args.catalogVersion,
    ...(args.timing === undefined ? {} : { timing: args.timing }),
  });
}

export const CONNECTOR_CATALOG_ACTIVE_MAX_BYTES = ACTIVE_POINTER_MAX_BYTES;

export function parseConnectorCatalogActivePointer(
  bytes: Uint8Array,
): ConnectorCatalogActivePointer {
  if (bytes.length > ACTIVE_POINTER_MAX_BYTES) {
    fail("object-too-large");
  }
  return parseStrict(
    decodedJson(bytes),
    connectorCatalogActivePointerSchema,
    "invalid-pointer",
  );
}

export async function loadConnectorCatalogCandidate(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly pointer: ConnectorCatalogActivePointer;
}): Promise<ValidatedConnectorCatalogCandidate> {
  const rawBytes = await readBoundedArtifact(
    args.reader,
    args.pointer.catalogKey,
    CONNECTOR_CATALOG_MAX_RAW_BYTES,
  );
  assertDigest(rawBytes, args.pointer.catalogDigest);
  const artifact = parseAndValidateCatalog({
    bytes: rawBytes,
    catalogVersion: args.pointer.catalogVersion,
  });
  return {
    identity: {
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.pointer.catalogVersion,
      catalogKey: args.pointer.catalogKey,
      catalogDigest: args.pointer.catalogDigest,
    },
    artifact,
    rawBytes,
  };
}

export function encodeConnectorCatalogSnapshot(rawBytes: Uint8Array): Buffer {
  return gzipSync(rawBytes);
}

function gunzipCatalog(bytes: Uint8Array): Buffer {
  const decompressed = attempt(() => {
    return gunzipSync(bytes, {
      maxOutputLength: CONNECTOR_CATALOG_MAX_RAW_BYTES,
    });
  });
  if ("ok" in decompressed) {
    return decompressed.ok;
  }
  if (
    isRecord(decompressed.error) &&
    decompressed.error.code === "ERR_BUFFER_TOO_LARGE"
  ) {
    fail("object-too-large");
  }
  fail("invalid-compression");
}

interface ConnectorCatalogSnapshotDecodeArgs {
  readonly catalogGzip: Uint8Array;
  readonly catalogRawSize: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly timing?: ConnectorCatalogValidationTiming;
}

function decodeConnectorCatalogSnapshotJson(
  args: ConnectorCatalogSnapshotDecodeArgs,
): unknown {
  if (
    args.catalogGzip.byteLength > CONNECTOR_CATALOG_MAX_GZIP_BYTES ||
    args.catalogRawSize > CONNECTOR_CATALOG_MAX_RAW_BYTES
  ) {
    fail("object-too-large");
  }
  const rawBytes = measureSnapshotPhase(
    args.timing,
    "api_dispatch_connector_catalog_decompress",
    () => {
      const decompressed = gunzipCatalog(args.catalogGzip);
      if (decompressed.byteLength !== args.catalogRawSize) {
        fail("invalid-reference");
      }
      return decompressed;
    },
  );
  measureSnapshotPhase(
    args.timing,
    "api_dispatch_connector_catalog_verify_digest",
    () => {
      assertDigest(rawBytes, args.catalogDigest);
    },
  );
  return decodeCatalogJson(rawBytes, args.timing);
}

export function decodeConnectorCatalogSnapshot(
  args: ConnectorCatalogSnapshotDecodeArgs,
): DecodedConnectorCatalogSnapshot {
  return {
    artifact: validateCatalogJson({
      json: decodeConnectorCatalogSnapshotJson(args),
      catalogVersion: args.catalogVersion,
      ...(args.timing === undefined ? {} : { timing: args.timing }),
    }),
  };
}

function assertAttestedConnectorCatalogArtifact(
  value: unknown,
  catalogVersion: string,
): asserts value is ConnectorCatalogArtifact {
  if (!isRecord(value)) {
    fail("invalid-artifact");
  }
  if (
    typeof value.artifactSchemaVersion === "number" &&
    value.artifactSchemaVersion !== SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION
  ) {
    fail("unsupported-schema");
  }
  if (
    value.artifactSchemaVersion !==
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION ||
    typeof value.catalogVersion !== "string"
  ) {
    fail("invalid-artifact");
  }
  if (value.catalogVersion !== catalogVersion) {
    fail("invalid-reference");
  }
}

export function decodeAttestedConnectorCatalogSnapshot(
  args: ConnectorCatalogSnapshotDecodeArgs,
): DecodedConnectorCatalogSnapshot {
  const artifact = decodeConnectorCatalogSnapshotJson(args);
  // The exact-digest compatibility row and current validator authority
  // establish deep schema and semantic validity. Keep this boundary local.
  assertAttestedConnectorCatalogArtifact(artifact, args.catalogVersion);
  return { artifact };
}
