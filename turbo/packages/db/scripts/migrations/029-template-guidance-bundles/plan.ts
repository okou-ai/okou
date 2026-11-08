import { readFile } from "node:fs/promises";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  url,
  iso,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import {
  templateGuidanceBundleSchema,
  MAX_TEMPLATE_GUIDANCE_ARCHIVE_BYTES,
  MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES,
  MAX_TEMPLATE_GUIDANCE_FILES,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";

export class BackfillError extends Error {}
export const digestSchema = string().regex(/^[a-f0-9]{64}$/u);
export const scopeSchema = object({
  database: string().min(1),
  bucket: string().min(1),
  endpoint: url(),
}).strict();
export const sourceSchema = object({
  ownerKind: zEnum(["user-template", "presentation-template"]),
  templateId: uuid(),
  orgId: string().min(1),
  ownerUserId: string().min(1),
  ownerUpdatedAt: iso.datetime(),
  package: object({
    storageId: uuid(),
    versionId: digestSchema,
    s3Key: string().min(1),
    archiveBytes: number()
      .int()
      .positive()
      .max(MAX_TEMPLATE_GUIDANCE_ARCHIVE_BYTES),
    totalBytes: number()
      .int()
      .positive()
      .max(MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES),
    fileCount: number().int().positive().max(MAX_TEMPLATE_GUIDANCE_FILES),
  }).strict(),
}).strict();
export const inventorySchema = object({
  format: literal("template-guidance-sources-v1"),
  capturedAt: iso.datetime(),
  scope: scopeSchema,
  rows: array(sourceSchema).min(1).max(100),
}).strict();
export const ownerSchema = object({
  revision: string(),
  fingerprint: string().regex(/^[a-f0-9]{32}$/u),
  orgId: string(),
  ownerUserId: string(),
  updatedAt: string(),
  bundle: templateGuidanceBundleSchema.nullable(),
});
export const plannedRowSchema = object({
  source: sourceSchema,
  owner: ownerSchema,
  archiveSha256: digestSchema,
  manifestSha256: digestSchema,
  bundle: templateGuidanceBundleSchema,
}).strict();
export const planSchema = object({
  format: literal("template-guidance-backfill-v1"),
  capturedAt: iso.datetime(),
  scope: scopeSchema,
  inventorySha256: digestSchema,
  complete: boolean(),
  rows: array(plannedRowSchema).max(100),
  failures: array(
    object({
      ownerKind: string(),
      templateId: uuid(),
      classification: string(),
    }),
  ),
}).strict();
export type Source = zInfer<typeof sourceSchema>;
export type Owner = zInfer<typeof ownerSchema>;
export type PlannedRow = zInfer<typeof plannedRowSchema>;

export function objectConfiguration() {
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey)
    throw new BackfillError("MissingConfiguration");
  const endpoint = new URL(
    process.env.R2_ENDPOINT ??
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  );
  const local =
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if (
    (!local &&
      !(
        endpoint.protocol === "https:" &&
        /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(endpoint.hostname)
      )) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new BackfillError("InvalidEndpoint");
  return { bucket, endpoint, credentials: { accessKeyId, secretAccessKey } };
}

export async function configuration() {
  const connection = process.env.DATABASE_URL_FILE
    ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
    : process.env.DATABASE_URL;
  if (!connection) throw new BackfillError("MissingDatabaseConfiguration");
  const objects = objectConfiguration();
  const address = new URL(connection);
  if (address.searchParams.has("host") || address.searchParams.has("port"))
    throw new BackfillError("InvalidDatabaseAddress");
  return {
    connection,
    ...objects,
    scope: {
      database: `${address.hostname}:${address.port || "5432"}${address.pathname}`,
      bucket: objects.bucket,
      endpoint: objects.endpoint.origin,
    },
  };
}

export function validateSources(rows: readonly Source[]) {
  const seen = new Set<string>();
  for (const source of rows) {
    const key = `${source.ownerKind}/${source.templateId}`;
    if (seen.has(key)) throw new BackfillError("DuplicateOwner");
    seen.add(key);
    if (
      source.package.s3Key !==
      `${source.orgId}/${source.package.storageId}/${source.package.versionId}`
    )
      throw new BackfillError("SourceScopeMismatch");
  }
}
