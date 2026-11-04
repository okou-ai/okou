import { createHash } from "node:crypto";
import {
  array,
  boolean,
  literal,
  url,
  iso,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { listPrivateRegistryResourceArchives } from "@okouai/core/private-registry-resource-archives";
import { registryResourceArchiveKey } from "@okouai/core/registry-resource-archive";
import { InventoryError, sourceSchema, type Binding } from "./source";

export const digestSchema = string().regex(/^[a-f0-9]{64}$/u);
export const headSchema = object({
  sha256: digestSchema,
  xmin: string().regex(/^\d+$/u),
});
const scopeSchema = object({
  database: string().min(1),
  bucket: string().min(1),
  endpoint: url(),
});
const rowSchema = object({
  resourceId: string(),
  selection: zEnum(["pinned", "latest"]),
  source: sourceSchema,
  archive: object({
    format: literal("registry-tar-gzip-v1"),
    sha256: digestSchema,
    archiveBytes: number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
  }),
  objectKey: string(),
  fileCount: number().int().positive().max(501),
  totalBytes: number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024),
});
export const inventorySchema = object({
  format: literal("registry-resource-inventory-v1"),
  mode: literal("read-only"),
  capturedAt: iso.datetime(),
  scope: scopeSchema,
  complete: literal(true),
  rows: array(rowSchema).min(1).max(1000),
  failures: array(
    object({
      resourceId: string(),
      selection: string(),
      classification: string(),
    }),
  ).length(0),
});
export const planSchema = object({
  format: literal("registry-resource-backfill-plan-v1"),
  mode: literal("read-only"),
  capturedAt: iso.datetime(),
  inventorySha256: digestSchema,
  scope: scopeSchema.extend({
    targetBucket: string().min(1),
    targetEndpoint: url(),
  }),
  complete: boolean(),
  rows: array(rowSchema.extend({ expectedHead: headSchema.nullable() })).max(
    1000,
  ),
  failures: array(
    object({
      resourceId: string(),
      selection: string(),
      classification: string(),
    }),
  ),
});
export type InventoryRow = zInfer<typeof rowSchema>;
export type PlanRow = zInfer<typeof planSchema>["rows"][number];

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function bindingFor(row: InventoryRow): Binding {
  const binding = listPrivateRegistryResourceArchives().find((entry) => {
    return entry.id === row.resourceId;
  });
  if (!binding || (row.selection === "latest" && !binding.latest)) {
    throw new InventoryError("UnknownResourceSelection");
  }
  if (
    row.objectKey !== registryResourceArchiveKey(row.archive.sha256) ||
    row.source.s3Key !== `${row.source.s3Prefix}/${row.source.versionId}` ||
    row.source.archiveBytes !== row.archive.archiveBytes ||
    row.source.fileCount !== row.fileCount ||
    row.source.totalBytes !== row.totalBytes ||
    (row.selection === "pinned" &&
      (row.archive.sha256 !== binding.sha256 ||
        row.source.versionId !== binding.versionId)) ||
    (row.selection === "latest" &&
      row.source.versionId !== row.source.headVersionId)
  )
    throw new InventoryError("InventoryBindingMismatch");
  if (
    row.archive.sha256 === binding.sha256 &&
    row.source.versionId !== binding.versionId
  ) {
    throw new InventoryError("OpaqueVersionAliasConflict");
  }
  return binding;
}

export function validateRows(rows: InventoryRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    bindingFor(row);
    const key = `${row.resourceId}/${row.selection}`;
    if (seen.has(key)) throw new InventoryError("DuplicateResourceSelection");
    seen.add(key);
  }
}

// Preserve the exact opaque response value; conflicting aliases are rejected
// by bindingFor rather than silently changing a pinned or latest version ID.
export function archiveMetadata(row: InventoryRow) {
  return {
    sha256: row.archive.sha256,
    archiveBytes: row.archive.archiveBytes,
    versionId: row.source.versionId,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
  };
}
