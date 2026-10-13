import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { inspectArchive } from "./archive.mjs";
import { requiredEnv } from "./options.mjs";
import { sha256, writeLine } from "./shared.mjs";

export function createR2Client() {
  const accountId = requiredEnv("R2_ACCOUNT_ID");
  return {
    bucket: requiredEnv("R2_USER_STORAGES_BUCKET_NAME"),
    client: new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
    }),
  };
}

function isPreconditionFailure(error) {
  return (
    error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 412
  );
}

async function putImmutable(client, bucket, key, body, contentType) {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!isPreconditionFailure(error)) {
      throw error;
    }
  }
}

async function getObject(client, bucket, key) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error("R2 returned an empty object body");
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

function assertManifest(actual, expected, slug) {
  if (
    actual.version !== expected.version ||
    actual.totalSize !== expected.totalSize ||
    actual.fileCount !== expected.fileCount ||
    JSON.stringify(actual.files) !== JSON.stringify(expected.files) ||
    Number.isNaN(Date.parse(actual.createdAt))
  ) {
    throw new Error(
      `${slug}: R2 manifest does not match the publication manifest`,
    );
  }
}

async function inspectUploadedArchive(archive, release) {
  const root = await mkdtemp(path.join(tmpdir(), `r2-${release.slug}-`));
  try {
    const archivePath = path.join(root, "archive.tar.gz");
    await writeFile(archivePath, archive);
    return await inspectArchive(archivePath, release, "uploaded-r2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createManifest(pkg) {
  return {
    version: pkg.versionId,
    createdAt: new Date().toISOString(),
    totalSize: pkg.totalSize,
    fileCount: pkg.fileCount,
    files: pkg.files,
  };
}

async function uploadObjects(client, bucket, s3Key, archive, manifest) {
  await putImmutable(
    client,
    bucket,
    `${s3Key}/archive.tar.gz`,
    archive,
    "application/gzip",
  );
  await putImmutable(
    client,
    bucket,
    `${s3Key}/manifest.json`,
    `${JSON.stringify(manifest)}\n`,
    "application/json",
  );
}

export async function uploadPackage({
  client,
  bucket,
  outputDir,
  pkg,
  release,
  current,
}) {
  const s3Key = `${current.storage.s3_prefix}/${pkg.versionId}`;
  const archive = await readFile(path.join(outputDir, pkg.archive.path));
  if (sha256(archive) !== release.newSha256) {
    throw new Error(`${pkg.slug}: artifact changed after verification`);
  }

  const manifest = createManifest(pkg);
  await uploadObjects(client, bucket, s3Key, archive, manifest);
  const [uploadedArchive, uploadedManifest] = await Promise.all([
    getObject(client, bucket, `${s3Key}/archive.tar.gz`),
    getObject(client, bucket, `${s3Key}/manifest.json`),
  ]);
  if (sha256(uploadedArchive) !== release.newSha256) {
    throw new Error(`${pkg.slug}: uploaded R2 archive sha256 mismatch`);
  }
  assertManifest(
    JSON.parse(uploadedManifest.toString("utf8")),
    manifest,
    pkg.slug,
  );

  const inspected = await inspectUploadedArchive(uploadedArchive, release);
  writeLine(
    `VERIFIED R2 ${pkg.slug} version=${release.newVersionId} sha256=${release.newSha256} skillBytes=${inspected.skillBytes}`,
  );
  return { ...current, pkg, s3Key, archiveSize: uploadedArchive.byteLength };
}

export async function verifyR2Objects(client, bucket, releases, state) {
  for (const release of releases) {
    const current = state.get(release.slug);
    await Promise.all([
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `${current.s3Key}/archive.tar.gz`,
        }),
      ),
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `${current.s3Key}/manifest.json`,
        }),
      ),
    ]);
  }
}
