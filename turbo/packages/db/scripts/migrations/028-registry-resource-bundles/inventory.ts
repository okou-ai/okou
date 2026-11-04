import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { enum as zEnum } from "zod";
import { listPrivateRegistryResourceArchives } from "@okouai/core/private-registry-resource-archives";
import {
  inspectRegistryResourceArchive,
  RegistryArchiveValidationError,
  registryResourceArchiveKey,
} from "@okouai/core/registry-resource-archive";

import {
  configuration,
  loadSource,
  InventoryError,
  type Source,
  type Binding,
} from "./source";

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
