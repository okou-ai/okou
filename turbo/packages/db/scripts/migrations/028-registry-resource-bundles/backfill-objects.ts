import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { inspectRegistryResourceArchive } from "@okouai/core/registry-resource-archive";
import { InventoryError } from "./source";
import { bindingFor, type InventoryRow } from "./backfill-plan";

function missing(error: unknown): boolean {
  return (
    error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)
  );
}

async function readObject(
  client: S3Client,
  bucket: string,
  key: string,
  row: InventoryRow,
) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    {
      abortSignal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.Body) throw new InventoryError("MissingArchiveBody");
  if (response.ContentLength !== row.archive.archiveBytes) {
    await response.Body.transformToWebStream().cancel();
    throw new InventoryError("ArchiveLengthMismatch");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  const reader = response.Body.transformToWebStream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = Buffer.from(next.value);
      length += bytes.length;
      if (length > row.archive.archiveBytes)
        throw new InventoryError("ArchiveLengthMismatch");
      chunks.push(bytes);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  const inspected = inspectRegistryResourceArchive(
    bytes,
    row.archive.sha256,
    bindingFor(row).sourcePath,
  );
  if (
    inspected.descriptor.archiveBytes !== row.archive.archiveBytes ||
    inspected.fileCount !== row.fileCount ||
    inspected.totalBytes !== row.totalBytes
  ) {
    throw new InventoryError("ArchiveMetadataMismatch");
  }
  return bytes;
}

export function sourceBytes(
  client: S3Client,
  bucket: string,
  row: InventoryRow,
) {
  return readObject(client, bucket, `${row.source.s3Key}/archive.tar.gz`, row);
}

export async function targetExists(
  client: S3Client,
  bucket: string,
  row: InventoryRow,
): Promise<boolean> {
  try {
    await readObject(client, bucket, row.objectKey, row);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function publishObject(
  client: S3Client,
  bucket: string,
  row: InventoryRow,
  bytes: Buffer,
): Promise<void> {
  if (await targetExists(client, bucket, row)) return;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: row.objectKey,
        Body: bytes,
        ContentType: "application/gzip",
        IfNoneMatch: "*",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  } catch {
    // A precondition race or lost response is resolved by authoritative bytes,
    // never by replaying a possibly successful PUT or deleting an orphan.
    if (await targetExists(client, bucket, row)) return;
    throw new InventoryError("ObjectPublicationUnresolved");
  }
  if (!(await targetExists(client, bucket, row)))
    throw new InventoryError("ObjectReadbackMissing");
}
