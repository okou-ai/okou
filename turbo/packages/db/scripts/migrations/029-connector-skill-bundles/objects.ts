import {
  S3Client,
  S3ServiceException,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  contentBundleDigest,
  contentBundleKey,
  readContentBundle,
} from "@okouai/core/content-bundle";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { BackfillError, type Source } from "./command";

async function readObject(
  client: S3Client,
  bucket: string,
  key: string,
  length: number,
): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!response.Body) throw new BackfillError("ArchiveBodyMissing");
  const reader = response.Body.transformToWebStream().getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (response.ContentLength !== length)
      throw new BackfillError("ArchiveLengthMismatch");
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > length) throw new BackfillError("ArchiveLengthMismatch");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel();
  }
  if (total !== length) throw new BackfillError("ArchiveLengthMismatch");
  return Buffer.concat(chunks);
}

function verifyArchive(
  bytes: Buffer,
  reference: ContentBundle,
  source: Source,
) {
  try {
    const files = readContentBundle(bytes, reference);
    if (
      files.length !== source.fileCount ||
      files[0]?.path !== "SKILL.md" ||
      files[0].content.length !== source.contentBytes
    )
      throw new BackfillError("ArchiveFileMismatch");
    const version = computeContentHashFromHashes(
      source.storageId,
      files.map((file) => {
        return {
          path: file.path,
          hash: hashFileContent(file.content),
          size: file.content.length,
        };
      }),
    );
    if (version !== source.sourceVersionId)
      throw new BackfillError("LegacyContentHashMismatch");
  } catch (error) {
    if (error instanceof BackfillError) throw error;
    throw new BackfillError("ArchiveValidationFailed");
  }
}

export async function sourceArchive(
  client: S3Client,
  bucket: string,
  source: Source,
) {
  const bytes = await readObject(
    client,
    bucket,
    `${source.s3Key}/archive.tar.gz`,
    source.archiveBytes,
  );
  const target = {
    sha256: contentBundleDigest(bytes),
    archiveBytes: bytes.length,
  };
  verifyArchive(bytes, target, source);
  return { bytes, target };
}

export async function targetExists(
  client: S3Client,
  bucket: string,
  reference: ContentBundle,
  source: Source,
): Promise<boolean> {
  try {
    const bytes = await readObject(
      client,
      bucket,
      contentBundleKey(reference.sha256),
      reference.archiveBytes,
    );
    verifyArchive(bytes, reference, source);
    return true;
  } catch (error) {
    if (
      error instanceof S3ServiceException &&
      error.$metadata.httpStatusCode === 404 &&
      ["NoSuchKey", "NotFound"].includes(error.name)
    )
      return false;
    throw error;
  }
}

export async function publishArchive(
  client: S3Client,
  bucket: string,
  source: Source,
  reference: ContentBundle,
  bytes: Buffer,
) {
  if (await targetExists(client, bucket, reference, source)) return;
  if (
    contentBundleDigest(bytes) !== reference.sha256 ||
    bytes.length !== reference.archiveBytes
  )
    throw new BackfillError("ReviewedArchiveMismatch");
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: contentBundleKey(reference.sha256),
        Body: bytes,
        ContentType: "application/gzip",
        IfNoneMatch: "*",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  } catch {
    // Resolve an uncertain PUT through readback; never repeat it or delete shared bytes.
    if (await targetExists(client, bucket, reference, source)) return;
    throw new BackfillError("ObjectPublicationUnresolved");
  }
  if (!(await targetExists(client, bucket, reference, source)))
    throw new BackfillError("ObjectReadbackMissing");
}
