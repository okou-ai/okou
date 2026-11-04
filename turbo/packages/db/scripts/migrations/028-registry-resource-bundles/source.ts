import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { number, object, string, uuid, type infer as zInfer } from "zod";
import { listPrivateRegistryResourceArchives } from "@okouai/core/private-registry-resource-archives";

export const sourceSchema = object({
  storageId: uuid(),
  storageXmin: string(),
  versionXmin: string(),
  versionId: string().regex(/^[a-f0-9]{64}$/u),
  headVersionId: string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  s3Prefix: string().min(1),
  s3Key: string().min(1),
  archiveBytes: number().int().positive(),
  totalBytes: number().int().nonnegative(),
  fileCount: number().int().positive(),
});
export type Source = zInfer<typeof sourceSchema>;
export type Binding = ReturnType<
  typeof listPrivateRegistryResourceArchives
>[number];

export class InventoryError extends Error {
  constructor(readonly classification: string) {
    super(classification);
  }
}

export function readEndpoint(
  value = process.env.R2_ENDPOINT ??
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined),
): URL {
  if (!value) {
    throw new InventoryError("MissingR2Endpoint");
  }
  const endpoint = new URL(value);
  const nativeR2 =
    endpoint.protocol === "https:" &&
    endpoint.hostname.endsWith(".r2.cloudflarestorage.com");
  const localPeer =
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if (
    (!nativeR2 && !localPeer) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new InventoryError("InvalidR2Endpoint");
  }
  return endpoint;
}

export async function configuration() {
  const connection = process.env.DATABASE_URL_FILE
    ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
    : process.env.DATABASE_URL;
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!connection || !bucket || !accessKeyId || !secretAccessKey) {
    throw new InventoryError("MissingInventoryConfiguration");
  }
  const endpoint = readEndpoint();
  const address = new URL(connection);
  if (address.searchParams.has("host") || address.searchParams.has("port")) {
    throw new InventoryError("NonCanonicalDatabaseAddress");
  }
  return {
    connection,
    bucket,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    scope: {
      database: `${address.hostname}:${address.port || "5432"}${address.pathname}`,
      bucket,
      endpoint: endpoint.origin,
    },
  };
}

export async function loadSource(
  sql: postgres.Sql,
  binding: Binding,
  selection: "pinned" | "latest",
): Promise<Source> {
  const rows = await sql`
    SELECT
      s.id AS "storageId",
      s.xmin::text AS "storageXmin",
      v.xmin::text AS "versionXmin",
      v.id AS "versionId",
      s.head_version_id AS "headVersionId",
      s.s3_prefix AS "s3Prefix",
      v.s3_key AS "s3Key",
      v.archive_size::float8 AS "archiveBytes",
      v.size::float8 AS "totalBytes",
      v.file_count AS "fileCount"
    FROM storage_versions anchor
    JOIN storages s ON s.id = anchor.storage_id
    JOIN storage_versions v ON v.storage_id = s.id
    WHERE
      anchor.id = ${binding.versionId}
      AND s.name = ${binding.storageName}
      AND v.id = CASE
        WHEN ${selection} = 'latest' THEN s.head_version_id
        ELSE anchor.id
      END
  `;
  if (rows.length !== 1) throw new InventoryError("SourceArchiveNotFound");
  const row = sourceSchema.parse(rows[0]);
  if (row.s3Key !== `${row.s3Prefix}/${row.versionId}`) {
    throw new InventoryError("UnexpectedSourceObjectKey");
  }
  return row;
}
