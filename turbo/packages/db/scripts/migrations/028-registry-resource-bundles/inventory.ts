import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import postgres from "postgres";
import {
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { listPrivateRegistryResourceArchives } from "@okouai/core/private-registry-resource-archives";
import {
  inspectRegistryResourceArchive,
  RegistryArchiveValidationError,
  registryResourceArchiveKey,
} from "@okouai/core/registry-resource-archive";

const sourceSchema = object({
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
type Source = zInfer<typeof sourceSchema>;
type Binding = ReturnType<typeof listPrivateRegistryResourceArchives>[number];

class InventoryError extends Error {
  constructor(readonly classification: string) {
    super(classification);
  }
}

function options() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "resource-id": { type: "string" },
      selection: { type: "string", default: "all" },
      migrate: { type: "boolean", default: false },
    },
  });
  if (values.migrate) throw new InventoryError("PreparationIsReadOnly");
  if (!values.output) throw new InventoryError("OutputFileRequired");
  const selection = zEnum(["all", "pinned", "latest"]).parse(values.selection);
  const bindings = listPrivateRegistryResourceArchives().filter((binding) => {
    return (
      (!values["resource-id"] || binding.id === values["resource-id"]) &&
      (selection !== "latest" || binding.latest)
    );
  });
  if (!bindings.length) throw new InventoryError("UnknownResourceId");
  return { output: values.output, bindings, selection };
}

function readEndpoint(): URL {
  if (!process.env.R2_ENDPOINT && !process.env.R2_ACCOUNT_ID) {
    throw new InventoryError("MissingR2Endpoint");
  }
  const endpoint = new URL(
    process.env.R2_ENDPOINT ??
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  );
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

async function configuration() {
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

async function loadSource(
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

function sourceUnchanged(left: Source, right: Source): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inspectSource(
  sql: postgres.Sql,
  client: S3Client,
  bucket: string,
  binding: Binding,
  selection: "pinned" | "latest",
) {
  const source = await loadSource(sql, binding, selection);
  if (source.archiveBytes > 32 * 1024 * 1024) {
    throw new InventoryError("SourceArchiveExceedsCompressedByteLimit");
  }
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `${source.s3Key}/archive.tar.gz`,
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!response.Body) throw new InventoryError("MissingArchiveBody");
  if (response.ContentLength !== source.archiveBytes) {
    throw new InventoryError("SourceArchiveLengthMismatch");
  }
  const archive = Buffer.from(await response.Body.transformToByteArray());
  const inspected = inspectRegistryResourceArchive(
    archive,
    selection === "pinned" ? binding.sha256 : undefined,
    binding.sourcePath,
  );
  if (
    inspected.descriptor.archiveBytes !== source.archiveBytes ||
    inspected.fileCount !== source.fileCount ||
    inspected.totalBytes !== source.totalBytes
  ) {
    throw new InventoryError("SourceArchiveMetadataMismatch");
  }
  const current = await loadSource(sql, binding, selection);
  if (!sourceUnchanged(source, current)) {
    throw new InventoryError("SourceChangedDuringInventory");
  }
  return {
    resourceId: binding.id,
    selection,
    source,
    archive: inspected.descriptor,
    objectKey: registryResourceArchiveKey(inspected.descriptor.sha256),
    fileCount: inspected.fileCount,
    totalBytes: inspected.totalBytes,
  };
}

function classification(error: unknown): string {
  if (error instanceof InventoryError) return error.classification;
  if (error instanceof RegistryArchiveValidationError) return error.message;
  if (error instanceof Error) return error.name;
  return "UnknownInventoryFailure";
}

async function main() {
  const selected = options();
  // Reserve a private receipt before external work; never overwrite an earlier inventory.
  const output = await open(selected.output, "wx", 0o600);
  let sql: postgres.Sql | undefined;
  let client: S3Client | undefined;
  try {
    const config = await configuration();
    sql = postgres(config.connection, {
      max: 1,
      connect_timeout: 10,
      connection: {
        default_transaction_read_only: true,
        statement_timeout: 30_000,
      },
    });
    client = new S3Client({
      region: "auto",
      endpoint: config.endpoint.toString(),
      credentials: config.credentials,
      maxAttempts: 1,
    });
    const rows = [];
    const failures = [];
    for (const binding of selected.bindings) {
      const selections =
        selected.selection === "latest"
          ? (["latest"] as const)
          : binding.latest && selected.selection === "all"
            ? (["pinned", "latest"] as const)
            : (["pinned"] as const);
      for (const selection of selections) {
        try {
          rows.push(
            await inspectSource(sql, client, config.bucket, binding, selection),
          );
        } catch (error) {
          failures.push({
            resourceId: binding.id,
            selection,
            classification: classification(error),
          });
        }
      }
    }
    const complete = failures.length === 0;
    const bytes = `${JSON.stringify(
      {
        format: "registry-resource-inventory-v1",
        mode: "read-only",
        capturedAt: new Date().toISOString(),
        scope: config.scope,
        complete,
        rows,
        failures,
      },
      null,
      2,
    )}\n`;
    await output.writeFile(bytes);
    process.stdout.write(
      `${JSON.stringify({
        complete,
        verified: rows.length,
        failed: failures.length,
        inventorySha256: createHash("sha256").update(bytes).digest("hex"),
      })}\n`,
    );
    if (!complete) process.exitCode = 1;
  } finally {
    try {
      if (sql) await sql.end({ timeout: 5 });
    } finally {
      client?.destroy();
      await output.close();
    }
  }
}

try {
  await main();
} catch (error) {
  // Provider diagnostics can contain database URLs; keep them out of receipts and logs.
  const message =
    error instanceof InventoryError
      ? error.classification
      : "RegistryInventoryFailed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
