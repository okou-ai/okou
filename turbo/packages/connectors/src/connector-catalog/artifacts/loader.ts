import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CONNECTOR_CATALOG_MAX_RAW_BYTES,
  type ConnectorCatalogValidationFailureCode,
} from "../contracts";
import { attempt, parseJson } from "../safe";
import {
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

const connectorCatalogActivePointerSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    catalogKey: artifactKeySchema,
    catalogDigest: digestSchema,
  })
  .strict()
  .refine((pointer) => {
    return (
      pointer.catalogKey ===
      `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/releases/${pointer.catalogVersion}/catalog.json`
    );
  }, "Catalog key must match its supported generation and release version");

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

function parseAndValidateCatalog(args: {
  readonly bytes: Uint8Array;
  readonly catalogVersion: string;
}): ConnectorCatalogArtifact {
  const json = decodedJson(args.bytes);
  assertSupportedArtifactSchema(json);
  const artifact = parseStrict<ConnectorCatalogArtifact>(
    json,
    connectorCatalogArtifactSchema,
    "invalid-artifact",
  );
  if (artifact.catalogVersion !== args.catalogVersion) {
    fail("invalid-reference");
  }
  const publicProjection = attempt(() => {
    validateConnectorCatalogPublicProjection(artifact);
  });
  if (!("ok" in publicProjection)) {
    fail("public-leakage");
  }
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
  return artifact;
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
  parseStrict(
    args.pointer,
    connectorCatalogActivePointerSchema,
    "invalid-pointer",
  );
  const rawBytes = await readBoundedArtifact(
    args.reader,
    args.pointer.catalogKey,
    CONNECTOR_CATALOG_MAX_RAW_BYTES,
  );
  return validateConnectorCatalogCandidateBytes({
    pointer: args.pointer,
    rawBytes,
  });
}

// Pure validation for callers whose owning gateway has already captured bytes.
// Keep the reader API above for existing consumers; do not inject I/O into a
// command's value input merely to reuse validation.
export function validateConnectorCatalogCandidateBytes(args: {
  readonly pointer: ConnectorCatalogActivePointer;
  readonly rawBytes: Uint8Array;
}): ValidatedConnectorCatalogCandidate {
  parseStrict(
    args.pointer,
    connectorCatalogActivePointerSchema,
    "invalid-pointer",
  );
  const rawBytes = Buffer.from(args.rawBytes);
  if (rawBytes.length > CONNECTOR_CATALOG_MAX_RAW_BYTES)
    fail("object-too-large");
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
