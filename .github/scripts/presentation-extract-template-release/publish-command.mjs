import { readFile } from "node:fs/promises";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { createDatabaseClient } from "../presentation-template-release/database.mjs";
import {
  requiredEnv,
  requiredOption,
} from "../presentation-template-release/options.mjs";
import { createR2Client } from "../presentation-template-release/r2.mjs";
import { sha256 } from "../presentation-template-release/shared.mjs";
import { release, storageManifest, verifyBundle } from "./bundle.mjs";
import {
  assertPublicationState,
  loadOwner,
  registerPublication,
  storageIdentity,
} from "./database.mjs";

async function verifyObject(client, bucket, object) {
  let response;
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: object.key }),
    );
  } catch (error) {
    if (
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
  if (!response.Body) {
    throw new Error(`R2 returned an empty body: ${object.key}`);
  }
  const actual = Buffer.from(await response.Body.transformToByteArray());
  if (!actual.equals(object.body)) {
    throw new Error(`Immutable R2 object has different bytes: ${object.key}`);
  }
  return true;
}

async function uploadObjects(client, bucket, objects) {
  // Reject all known conflicts before writing even the first object.
  const exists = await Promise.all(
    objects.map((object) => verifyObject(client, bucket, object)),
  );
  for (const [index, object] of objects.entries()) {
    if (exists[index]) {
      continue;
    }
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: object.key,
          Body: object.body,
          ContentType: object.contentType,
          CacheControl: "private, max-age=31536000, immutable",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (
        error?.name !== "PreconditionFailed" &&
        error?.$metadata?.httpStatusCode !== 412
      ) {
        throw error;
      }
    }
  }
  for (const object of objects) {
    if (!(await verifyObject(client, bucket, object))) {
      throw new Error(`Uploaded R2 object is missing: ${object.key}`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
if (command !== "publish" || !args.includes("--execute")) {
  throw new Error("Publication requires publish --execute.");
}
const outputDir = path.resolve(requiredOption(args, "--output-dir"));
const publication = await verifyBundle(outputDir);
const archive = await readFile(path.join(outputDir, publication.archive.path));
const manifest = await readFile(path.join(outputDir, "manifest.json"));
if (
  sha256(archive) !== release.archiveSha256 ||
  manifest.toString("utf8") !==
    `${JSON.stringify(storageManifest(publication))}\n`
) {
  throw new Error("Publication files changed after bundle verification.");
}
const databaseUrl = requiredEnv("DATABASE_URL");
const { bucket, client } = createR2Client();
const sql = createDatabaseClient(databaseUrl);
try {
  const owner = await loadOwner(sql);
  await assertPublicationState(sql, owner, publication);
  const { key } = storageIdentity(owner);
  await uploadObjects(client, bucket, [
    {
      key: `${key}/archive.tar.gz`,
      body: archive,
      contentType: "application/gzip",
    },
    {
      key: `${key}/manifest.json`,
      body: manifest,
      contentType: "application/json",
    },
  ]);
  await registerPublication(sql, owner, publication);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "published-and-verified",
        resourceId: release.resourceId,
        storageId: release.storageId,
        versionId: release.versionId,
        archiveSha256: publication.archive.sha256,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await sql.end({ timeout: 5 });
  client.destroy();
}
