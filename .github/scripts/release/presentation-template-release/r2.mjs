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

function r2Client(accessKeyId, secretAccessKey) {
  const accountId = requiredEnv("R2_ACCOUNT_ID");
  const endpoint = new URL(
    process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
  );
  const native =
    endpoint.origin === `https://${accountId}.r2.cloudflarestorage.com`;
  const local =
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(endpoint.hostname);
  if (
    (!native && !local) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "R2_ENDPOINT must be the account's native endpoint or a loopback fixture",
    );
  }
  return new S3Client({
    region: "auto",
    endpoint: endpoint.origin,
    forcePathStyle: local,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

export function createR2Client() {
  return {
    bucket: requiredEnv("R2_USER_STORAGES_BUCKET_NAME"),
    client: r2Client(
      requiredEnv("R2_ACCESS_KEY_ID"),
      requiredEnv("R2_SECRET_ACCESS_KEY"),
    ),
  };
}

export function createRegistryR2Client() {
  return {
    bucket: requiredEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
    client: r2Client(
      requiredEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID"),
      requiredEnv("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY"),
    ),
  };
}

function isPreconditionFailure(error) {
  return (
    error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 412
  );
}

async function putImmutable(client, bucket, key, body, contentType, verify) {
  let writeError;
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
    writeError = error;
  }
  // A missing PUT response can follow a committed write. Read once; never
  // replay the mutation or overwrite a conflicting immutable object.
  let uploaded;
  try {
    uploaded = await getObject(
      client,
      bucket,
      key,
      Math.max(Buffer.byteLength(body), 64 * 1024),
    );
  } catch (error) {
    throw writeError && !isPreconditionFailure(writeError) ? writeError : error;
  }
  verify(uploaded);
  return uploaded;
}

async function getObject(client, bucket, key, maxBytes) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error("R2 returned an empty object body");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.Body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes)
      throw new Error("R2 object exceeds the verified publication size");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
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

async function uploadObjects(client, bucket, s3Key, archive, manifest, slug) {
  const uploadedArchive = await putImmutable(
    client,
    bucket,
    `${s3Key}/archive.tar.gz`,
    archive,
    "application/gzip",
    (actual) => {
      if (!actual.equals(archive))
        throw new Error(`${slug}: immutable R2 archive conflicts`);
    },
  );
  await putImmutable(
    client,
    bucket,
    `${s3Key}/manifest.json`,
    `${JSON.stringify(manifest)}\n`,
    "application/json",
    (actual) =>
      assertManifest(JSON.parse(actual.toString("utf8")), manifest, slug),
  );
  return uploadedArchive;
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
  const uploadedArchive = await uploadObjects(
    client,
    bucket,
    s3Key,
    archive,
    manifest,
    pkg.slug,
  );

  const inspected = await inspectUploadedArchive(uploadedArchive, release);
  writeLine(
    `VERIFIED R2 ${pkg.slug} version=${release.newVersionId} sha256=${release.newSha256} skillBytes=${inspected.skillBytes}`,
  );
  return { ...current, pkg, s3Key, archiveSize: uploadedArchive.byteLength };
}

export async function uploadRegistryPackage({
  client,
  bucket,
  outputDir,
  pkg,
  release,
}) {
  const archive = await readFile(path.join(outputDir, pkg.archive.path));
  if (
    sha256(archive) !== release.newSha256 ||
    archive.length !== pkg.registryArchive.archiveBytes
  ) {
    throw new Error(`${pkg.slug}: artifact changed before registry upload`);
  }
  await putImmutable(
    client,
    bucket,
    pkg.registryArchive.objectKey,
    archive,
    "application/gzip",
    (actual) => {
      if (!actual.equals(archive))
        throw new Error(`${pkg.slug}: immutable registry object conflicts`);
    },
  );
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
