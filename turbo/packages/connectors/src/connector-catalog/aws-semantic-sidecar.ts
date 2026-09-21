import { createHash } from "node:crypto";

import { z } from "zod";

import {
  artifactKeySchema,
  connectorCatalogVersionSchema,
  digestSchema,
} from "./artifacts/common";

export const AWS_SEMANTIC_SIDECAR_SCHEMA_VERSION = 1;
export const AWS_SEMANTIC_MANIFEST_MAX_BYTES = 64 * 1024;
export const AWS_SEMANTIC_SERVICE_SHARD_MAX_BYTES = 2 * 1024 * 1024;
export const AWS_SEMANTIC_RELEASE_MAX_SHARD_BYTES = 4 * 1024 * 1024;

const AWS_SEMANTIC_MAX_PERMISSIONS = 2_048;
const AWS_SEMANTIC_MAX_OPERATIONS = 2_048;
const AWS_SEMANTIC_MAX_SELECTORS_PER_OPERATION = 32;
const AWS_SEMANTIC_MAX_EFFECTS_PER_OPERATION = 32;
const AWS_SEMANTIC_MAX_PREDICATES = 32;
const AWS_SEMANTIC_MAX_DESCRIPTION_LENGTH = 1_024;
const AWS_SEMANTIC_MAX_EXACT_VALUE_LENGTH = 256;

const AWS_IAM_ACTION_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}:[A-Za-z][A-Za-z0-9]*$/u;
const AWS_OPERATION_PATTERN = /^[A-Z][A-Za-z0-9]*$/u;
const AWS_RULE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const AWS_QUERY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const AWS_HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/u;

export const awsSemanticServiceSchema = z.enum(["ec2", "iam", "s3"]);
export const awsSemanticProtocolSchema = z.enum(["query", "rest-xml"]);
export const awsSemanticPolicySchema = z.enum(["allow", "deny", "ask"]);
export const awsSemanticPermissionCategorySchema = z.enum([
  "read",
  "write",
  "permissions",
  "tagging",
  "credentials",
  "billing",
  "other",
]);

const awsIamActionSchema = z.string().max(128).regex(AWS_IAM_ACTION_PATTERN);
const awsOperationNameSchema = z.string().max(128).regex(AWS_OPERATION_PATTERN);
const awsRuleIdSchema = z.string().max(160).regex(AWS_RULE_ID_PATTERN);
const awsQueryNameSchema = z.string().max(128).regex(AWS_QUERY_NAME_PATTERN);
const awsHeaderNameSchema = z.string().max(128).regex(AWS_HEADER_NAME_PATTERN);

export const awsSemanticPermissionSchema = z
  .object({
    name: awsIamActionSchema,
    description: z.string().min(1).max(AWS_SEMANTIC_MAX_DESCRIPTION_LENGTH),
    category: awsSemanticPermissionCategorySchema,
    defaultPolicy: awsSemanticPolicySchema,
  })
  .strict()
  .superRefine((permission, context) => {
    if (
      permission.defaultPolicy === "allow" &&
      permission.category !== "read"
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultPolicy"],
        message: "Only read permissions may default to allow",
      });
    }
  });

export const awsSemanticQuerySelectorSchema = z
  .object({
    kind: z.literal("query-action"),
    action: awsOperationNameSchema,
  })
  .strict();

const awsSemanticPredicateMatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present") }).strict(),
  z
    .object({
      kind: z.literal("exact"),
      value: z
        .string()
        .max(AWS_SEMANTIC_MAX_EXACT_VALUE_LENGTH)
        .regex(PRINTABLE_ASCII_PATTERN),
    })
    .strict(),
]);

const awsSemanticQueryPredicateSchema = z
  .object({
    name: awsQueryNameSchema,
    match: awsSemanticPredicateMatchSchema,
  })
  .strict();

const awsSemanticHeaderPredicateSchema = z
  .object({
    name: awsHeaderNameSchema,
    match: awsSemanticPredicateMatchSchema,
  })
  .strict();

export const awsSemanticS3SelectorSchema = z
  .object({
    kind: z.literal("s3-rest-xml"),
    method: z.enum(["GET", "HEAD", "PUT", "POST", "DELETE"]),
    addressingStyle: z.enum(["path", "virtual-hosted"]),
    resource: z.enum(["service", "bucket", "object"]),
    requiredQuery: z
      .array(awsSemanticQueryPredicateSchema)
      .max(AWS_SEMANTIC_MAX_PREDICATES),
    excludedQueryNames: z
      .array(awsQueryNameSchema)
      .max(AWS_SEMANTIC_MAX_PREDICATES),
    requiredHeaders: z
      .array(awsSemanticHeaderPredicateSchema)
      .max(AWS_SEMANTIC_MAX_PREDICATES),
    excludedHeaderNames: z
      .array(awsHeaderNameSchema)
      .max(AWS_SEMANTIC_MAX_PREDICATES),
  })
  .strict()
  .superRefine((selector, context) => {
    validatePredicates(
      selector.requiredQuery,
      selector.excludedQueryNames,
      "requiredQuery",
      "excludedQueryNames",
      context,
    );
    validatePredicates(
      selector.requiredHeaders,
      selector.excludedHeaderNames,
      "requiredHeaders",
      "excludedHeaderNames",
      context,
    );
  });

export const awsSemanticSelectorSchema = z.discriminatedUnion("kind", [
  awsSemanticQuerySelectorSchema,
  awsSemanticS3SelectorSchema,
]);

export const awsSemanticOperationSchema = z
  .object({
    operation: awsOperationNameSchema,
    primaryPermission: awsIamActionSchema,
    authorizedEffects: z
      .array(awsIamActionSchema)
      .min(1)
      .max(AWS_SEMANTIC_MAX_EFFECTS_PER_OPERATION),
    ruleId: awsRuleIdSchema,
    selectors: z
      .array(awsSemanticSelectorSchema)
      .min(1)
      .max(AWS_SEMANTIC_MAX_SELECTORS_PER_OPERATION),
  })
  .strict()
  .superRefine((operation, context) => {
    validateSortedUniqueStrings(
      operation.authorizedEffects,
      "authorizedEffects",
      context,
    );
    if (!operation.authorizedEffects.includes(operation.primaryPermission)) {
      context.addIssue({
        code: "custom",
        path: ["primaryPermission"],
        message: "Primary permission must be included in authorized effects",
      });
    }
    validateSortedUniqueValues(operation.selectors, "selectors", context);
  });

export const awsSemanticServiceShardSchema = z
  .object({
    artifactSchemaVersion: z.literal(AWS_SEMANTIC_SIDECAR_SCHEMA_VERSION),
    kind: z.literal("aws-semantic-service-shard"),
    service: awsSemanticServiceSchema,
    protocol: awsSemanticProtocolSchema,
    permissions: z
      .array(awsSemanticPermissionSchema)
      .min(1)
      .max(AWS_SEMANTIC_MAX_PERMISSIONS),
    operations: z
      .array(awsSemanticOperationSchema)
      .min(1)
      .max(AWS_SEMANTIC_MAX_OPERATIONS),
  })
  .strict()
  .superRefine((shard, context) => {
    validateServiceProtocol(shard.service, shard.protocol, context);
    validateSortedUniqueBy(
      shard.permissions,
      (permission) => {
        return permission.name;
      },
      "permissions",
      context,
    );
    validateSortedUniqueBy(
      shard.operations,
      (operation) => {
        return operation.operation;
      },
      "operations",
      context,
    );

    const ruleIds = shard.operations.map((operation) => {
      return operation.ruleId;
    });
    validateUniqueStrings(ruleIds, "operations", context);
    const permissionNames = new Set(
      shard.permissions.map((permission) => {
        return permission.name;
      }),
    );
    const referencedPermissions = new Set<string>();
    for (const [operationIndex, operation] of shard.operations.entries()) {
      validateOperationForService(
        shard.service,
        operation,
        operationIndex,
        context,
      );
      for (const effect of operation.authorizedEffects) {
        referencedPermissions.add(effect);
        if (!permissionNames.has(effect)) {
          context.addIssue({
            code: "custom",
            path: ["operations", operationIndex, "authorizedEffects"],
            message: `Authorized effect is missing permission metadata: ${effect}`,
          });
        }
      }
    }
    for (const [permissionIndex, permission] of shard.permissions.entries()) {
      if (!referencedPermissions.has(permission.name)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", permissionIndex],
          message: `Permission metadata is not referenced: ${permission.name}`,
        });
      }
    }
  });

export const awsSemanticShardReferenceSchema = z
  .object({
    service: awsSemanticServiceSchema,
    key: artifactKeySchema,
    digest: digestSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(AWS_SEMANTIC_SERVICE_SHARD_MAX_BYTES),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.key !== awsSemanticShardKey(reference.digest)) {
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "Shard key must be derived from its digest",
      });
    }
  });

export const awsSemanticManifestSchema = z
  .object({
    artifactSchemaVersion: z.literal(AWS_SEMANTIC_SIDECAR_SCHEMA_VERSION),
    kind: z.literal("aws-semantic-manifest"),
    connector: z.literal("aws"),
    sourceSha: z.string().regex(GIT_SHA_PATTERN),
    connectorCatalogVersion: connectorCatalogVersionSchema,
    shards: z.array(awsSemanticShardReferenceSchema).min(1).max(3),
  })
  .strict()
  .superRefine((manifest, context) => {
    validateSortedUniqueBy(
      manifest.shards,
      (reference) => {
        return reference.service;
      },
      "shards",
      context,
    );
    const totalBytes = manifest.shards.reduce((total, reference) => {
      return total + reference.byteLength;
    }, 0);
    if (totalBytes > AWS_SEMANTIC_RELEASE_MAX_SHARD_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["shards"],
        message: "Combined shard byte length exceeds the release limit",
      });
    }
  });

export type AwsSemanticService = z.infer<typeof awsSemanticServiceSchema>;
export type AwsSemanticPermission = z.infer<typeof awsSemanticPermissionSchema>;
export type AwsSemanticSelector = z.infer<typeof awsSemanticSelectorSchema>;
export type AwsSemanticOperation = z.infer<typeof awsSemanticOperationSchema>;
export type AwsSemanticServiceShard = z.infer<
  typeof awsSemanticServiceShardSchema
>;
export type AwsSemanticShardReference = z.infer<
  typeof awsSemanticShardReferenceSchema
>;
export type AwsSemanticManifest = z.infer<typeof awsSemanticManifestSchema>;

export const AWS_SEMANTIC_SIDECAR_VALIDATION_FAILURE_CODES = [
  "object-too-large",
  "invalid-json",
  "unsupported-schema",
  "invalid-artifact",
  "noncanonical-artifact",
  "digest-mismatch",
  "invalid-reference",
] as const;

export type AwsSemanticSidecarValidationFailureCode =
  (typeof AWS_SEMANTIC_SIDECAR_VALIDATION_FAILURE_CODES)[number];

export class AwsSemanticSidecarValidationError extends Error {
  constructor(readonly code: AwsSemanticSidecarValidationFailureCode) {
    super(code);
    this.name = "AwsSemanticSidecarValidationError";
  }
}

export interface AwsSemanticManifestIdentity {
  readonly sourceSha: string;
  readonly connectorCatalogVersion: string;
  readonly digest: string;
}

export function awsSemanticShardKey(digest: string): string {
  const parsedDigest = digestSchema.safeParse(digest);
  if (!parsedDigest.success) {
    throw new AwsSemanticSidecarValidationError("invalid-reference");
  }
  return `connectors/aws-semantic/v1/shards/${parsedDigest.data.slice("sha256:".length)}.json`;
}

export function encodeAwsSemanticManifest(value: unknown): Buffer {
  const bytes = encodeCanonicalArtifact(value, awsSemanticManifestSchema);
  if (bytes.length > AWS_SEMANTIC_MANIFEST_MAX_BYTES) {
    fail("object-too-large");
  }
  return bytes;
}

export function encodeAwsSemanticServiceShard(value: unknown): Buffer {
  const bytes = encodeCanonicalArtifact(value, awsSemanticServiceShardSchema);
  if (bytes.length > AWS_SEMANTIC_SERVICE_SHARD_MAX_BYTES) {
    fail("object-too-large");
  }
  return bytes;
}

export function decodeAwsSemanticManifest(args: {
  readonly bytes: Uint8Array;
  readonly identity: AwsSemanticManifestIdentity;
}): AwsSemanticManifest {
  const bytes = Buffer.from(args.bytes);
  if (bytes.length > AWS_SEMANTIC_MANIFEST_MAX_BYTES) {
    fail("object-too-large");
  }
  assertDigest(bytes, args.identity.digest);
  const manifest = decodeCanonicalArtifact(bytes, awsSemanticManifestSchema);
  if (
    manifest.sourceSha !== args.identity.sourceSha ||
    manifest.connectorCatalogVersion !== args.identity.connectorCatalogVersion
  ) {
    fail("invalid-reference");
  }
  return manifest;
}

export function decodeAwsSemanticServiceShard(args: {
  readonly bytes: Uint8Array;
  readonly reference: AwsSemanticShardReference;
}): AwsSemanticServiceShard {
  const reference = parseArtifact(
    args.reference,
    awsSemanticShardReferenceSchema,
  );
  const bytes = Buffer.from(args.bytes);
  if (
    bytes.length > AWS_SEMANTIC_SERVICE_SHARD_MAX_BYTES ||
    bytes.length !== reference.byteLength
  ) {
    fail(
      bytes.length > AWS_SEMANTIC_SERVICE_SHARD_MAX_BYTES
        ? "object-too-large"
        : "invalid-reference",
    );
  }
  assertDigest(bytes, reference.digest);
  const shard = decodeCanonicalArtifact(bytes, awsSemanticServiceShardSchema);
  if (shard.service !== reference.service) {
    fail("invalid-reference");
  }
  return shard;
}

export function awsSemanticArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code: AwsSemanticSidecarValidationFailureCode): never {
  throw new AwsSemanticSidecarValidationError(code);
}

function assertDigest(bytes: Uint8Array, expectedDigest: string): void {
  if (!digestSchema.safeParse(expectedDigest).success) {
    fail("invalid-reference");
  }
  if (awsSemanticArtifactDigest(bytes) !== expectedDigest) {
    fail("digest-mismatch");
  }
}

function parseArtifact<T>(value: unknown, schema: z.ZodType<T>): T {
  if (
    typeof value === "object" &&
    value !== null &&
    "artifactSchemaVersion" in value &&
    typeof value.artifactSchemaVersion === "number" &&
    value.artifactSchemaVersion !== AWS_SEMANTIC_SIDECAR_SCHEMA_VERSION
  ) {
    fail("unsupported-schema");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    fail("invalid-artifact");
  }
  return parsed.data;
}

function encodeCanonicalArtifact<T>(
  value: unknown,
  schema: z.ZodType<T>,
): Buffer {
  const parsed = parseArtifact(value, schema);
  return Buffer.from(`${canonicalJsonString(parsed)}\n`, "utf8");
}

function decodeCanonicalArtifact<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-json");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail("invalid-json");
  }
  const parsed = parseArtifact(value, schema);
  if (!bytes.equals(Buffer.from(`${canonicalJsonString(parsed)}\n`, "utf8"))) {
    fail("noncanonical-artifact");
  }
  return parsed;
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          return [
            key,
            canonicalJsonValue((value as Record<string, unknown>)[key]),
          ];
        }),
    );
  }
  return value;
}

function validateSortedUniqueStrings(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  validateSortedUniqueBy(
    values,
    (value) => {
      return value;
    },
    path,
    context,
  );
}

function validateUniqueStrings(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "Values must be unique",
    });
  }
}

function validateSortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  const sorted = [...new Set(keys)].sort();
  if (
    sorted.length !== keys.length ||
    sorted.some((value, index) => {
      return value !== keys[index];
    })
  ) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "Values must be sorted and unique",
    });
  }
}

function validateSortedUniqueValues(
  values: readonly unknown[],
  path: string,
  context: z.RefinementCtx,
): void {
  validateSortedUniqueBy(values, canonicalJsonString, path, context);
}

function validatePredicates(
  required: readonly { readonly name: string }[],
  excluded: readonly string[],
  requiredPath: string,
  excludedPath: string,
  context: z.RefinementCtx,
): void {
  validateSortedUniqueBy(
    required,
    (predicate) => {
      return predicate.name;
    },
    requiredPath,
    context,
  );
  validateSortedUniqueStrings(excluded, excludedPath, context);
  const excludedNames = new Set(excluded);
  for (const [index, predicate] of required.entries()) {
    if (excludedNames.has(predicate.name)) {
      context.addIssue({
        code: "custom",
        path: [requiredPath, index, "name"],
        message: "A selector name cannot be both required and excluded",
      });
    }
  }
}

function validateServiceProtocol(
  service: AwsSemanticService,
  protocol: z.infer<typeof awsSemanticProtocolSchema>,
  context: z.RefinementCtx,
): void {
  const expected = service === "s3" ? "rest-xml" : "query";
  if (protocol !== expected) {
    context.addIssue({
      code: "custom",
      path: ["protocol"],
      message: `${service} requires protocol ${expected}`,
    });
  }
}

function validateOperationForService(
  service: AwsSemanticService,
  operation: AwsSemanticOperation,
  operationIndex: number,
  context: z.RefinementCtx,
): void {
  const expectedRulePrefix = `${service}.`;
  if (!operation.ruleId.startsWith(expectedRulePrefix)) {
    context.addIssue({
      code: "custom",
      path: ["operations", operationIndex, "ruleId"],
      message: `Rule ID must start with ${expectedRulePrefix}`,
    });
  }
  for (const [selectorIndex, selector] of operation.selectors.entries()) {
    if (service === "s3" && selector.kind !== "s3-rest-xml") {
      context.addIssue({
        code: "custom",
        path: ["operations", operationIndex, "selectors", selectorIndex],
        message: "S3 operations require S3 REST/XML selectors",
      });
    }
    if (service !== "s3" && selector.kind !== "query-action") {
      context.addIssue({
        code: "custom",
        path: ["operations", operationIndex, "selectors", selectorIndex],
        message: "EC2 and IAM operations require Query action selectors",
      });
    }
    if (
      selector.kind === "query-action" &&
      selector.action !== operation.operation
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "operations",
          operationIndex,
          "selectors",
          selectorIndex,
          "action",
        ],
        message: "Query action must match the operation name",
      });
    }
  }
}
