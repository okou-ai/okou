import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { requiredEnv } from "./options.mjs";
import { sha256 } from "./shared.mjs";

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
  return { pkg, archiveSize: archive.byteLength };
}
