import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { array, number, object, string } from "zod";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  MAX_TEMPLATE_GUIDANCE_TAR_BYTES,
  MAX_TEMPLATE_GUIDANCE_FILE_BYTES,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import {
  contentBundleDigest,
  contentBundleKey,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import {
  prepareTemplateGuidanceBundle,
  readTemplateGuidanceBundle,
  validateTemplateGuidanceFiles,
} from "@okouai/core/template-guidance-bundle";
import {
  BackfillError,
  digestSchema,
  type Source,
  type PlannedRow,
} from "./plan";

const manifestSchema = object({
  version: digestSchema,
  totalSize: number().int().nonnegative(),
  fileCount: number().int().positive(),
  files: array(
    object({
      path: string(),
      hash: digestSchema,
      size: number().int().nonnegative(),
    }),
  ).max(200),
});

async function readObject(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
) {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!result.Body) throw new BackfillError("MissingObjectBody");
  const stream = result.Body.transformToWebStream().getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes)
      throw new BackfillError("ObjectTooLarge");
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxBytes) throw new BackfillError("ObjectTooLarge");
      chunks.push(Buffer.from(chunk.value));
    }
    if (result.ContentLength !== undefined && result.ContentLength !== length)
      throw new BackfillError("ObjectLengthMismatch");
    return Buffer.concat(chunks);
  } finally {
    await stream.cancel();
  }
}

function readLegacyFiles(archive: Buffer): readonly ContentBundleFile[] {
  const bytes = gunzipSync(archive, {
    maxOutputLength: MAX_TEMPLATE_GUIDANCE_TAR_BYTES,
  });
  const files: ContentBundleFile[] = [];
  let failure: Error | undefined;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/^\.\//u, "");
      if (entry.type === "Directory") {
        if (
          path !== "." &&
          path !== "" &&
          (path.startsWith("/") ||
            path.includes("\\") ||
            path.split("/").some((p) => {
              return p === "..";
            }))
        )
          failure = new BackfillError("UnsafeDirectory");
        entry.resume();
        return;
      }
      if (
        !["File", "OldFile"].includes(entry.type) ||
        entry.size > MAX_TEMPLATE_GUIDANCE_FILE_BYTES ||
        files.length >= 200
      ) {
        failure = new BackfillError("UnsupportedArchiveEntry");
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        files.push({ path, content: Buffer.concat(chunks), mode: 0o644 });
      });
    },
  });
  parser.on("error", (error) => {
    failure = error;
  });
  parser.end(bytes);
  if (failure) throw failure;
  return validateTemplateGuidanceFiles(files);
}

export async function prepareSource(
  client: S3Client,
  bucket: string,
  source: Source,
) {
  const pkg = source.package;
  const manifestBytes = await readObject(
    client,
    bucket,
    `${pkg.s3Key}/manifest.json`,
    8 * 1024 * 1024,
  );
  const manifest = manifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  if (
    manifest.version !== pkg.versionId ||
    computeContentHashFromHashes(pkg.storageId, manifest.files) !==
      pkg.versionId ||
    manifest.fileCount !== pkg.fileCount ||
    manifest.totalSize !== pkg.totalBytes ||
    manifest.files.length !== pkg.fileCount
  )
    throw new BackfillError("ManifestIdentityMismatch");
  const archive = await readObject(
    client,
    bucket,
    `${pkg.s3Key}/archive.tar.gz`,
    pkg.archiveBytes,
  );
  if (archive.length !== pkg.archiveBytes)
    throw new BackfillError("ArchiveLengthMismatch");
  const files = readLegacyFiles(archive);
  const byPath = new Map(
    files.map((file) => {
      return [file.path, file];
    }),
  );
  if (
    files.length !== pkg.fileCount ||
    files.reduce((n, f) => {
      return n + f.content.length;
    }, 0) !== pkg.totalBytes ||
    new Set(
      manifest.files.map((f) => {
        return f.path;
      }),
    ).size !== files.length
  )
    throw new BackfillError("FileInventoryMismatch");
  for (const expected of manifest.files) {
    const file = byPath.get(expected.path);
    if (
      !file ||
      file.content.length !== expected.size ||
      contentBundleDigest(file.content) !== expected.hash
    )
      throw new BackfillError("FileIntegrityMismatch");
  }
  const required =
    source.ownerKind === "presentation-template"
      ? ["SKILL.md", "design-system.md"]
      : ["SKILL.md"];
  if (
    required.some((path) => {
      return !byPath.get(path)?.content.toString("utf8").trim();
    })
  )
    throw new BackfillError("MissingRequiredGuidance");
  const prepared = await prepareTemplateGuidanceBundle(files);
  readTemplateGuidanceBundle(prepared.archive, prepared.descriptor);
  return {
    ...prepared,
    archiveSha256: contentBundleDigest(archive),
    manifestSha256: contentBundleDigest(manifestBytes),
  };
}

export async function publishBundle(
  client: S3Client,
  bucket: string,
  row: PlannedRow,
  bytes: Buffer,
) {
  const key = contentBundleKey(row.bundle.sha256);
  const verify = async () => {
    const actual = await readObject(
      client,
      bucket,
      key,
      row.bundle.archiveBytes,
    );
    readTemplateGuidanceBundle(actual, row.bundle);
    if (!actual.equals(bytes)) throw new BackfillError("TargetObjectConflict");
  };
  try {
    await verify();
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["NoSuchKey", "NotFound"].includes(error.name)
    )
      throw error;
  }
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/gzip",
        IfNoneMatch: "*",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  } catch {
    // Resolve an uncertain PUT or precondition race by reading, never by overwriting.
    await verify();
    return;
  }
  await verify();
}
