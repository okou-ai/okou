import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import {
  contentBundleKey,
  prepareContentBundle,
  readContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import {
  readPrivate,
  writePrivate,
  sha256,
  databaseIdentity,
  type ExecutionImage,
} from "./execution-model";
import { PlanningError } from "./snapshot";
import { object, string } from "zod";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";

export function bundleConfiguration() {
  const endpointValue = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpointValue || !bucket || !accessKeyId || !secretAccessKey)
    throw new PlanningError(
      "ExplicitBundleEndpointBucketAndCredentialsRequired",
    );
  const endpoint = new URL(endpointValue);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(endpoint.hostname)
      ))
  )
    throw new PlanningError("InvalidBundleEndpoint");
  return {
    endpoint: endpoint.origin,
    bucket,
    credentials: { accessKeyId, secretAccessKey },
  };
}

/** Preserve executable attachment modes as well as complete file bytes. */
function verifiedFiles(archive: Buffer, bundle: ContentBundle) {
  const files = readContentBundle(archive, bundle);
  const modes = new Map<string, 0o600 | 0o644 | 0o755>();
  let failure: Error | undefined;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (entry.mode === undefined) {
        failure = new PlanningError("MissingSourceBundleMode");
        entry.resume();
        return;
      }
      const mode = entry.mode;
      if (mode !== 0o600 && mode !== 0o644 && mode !== 0o755)
        failure = new PlanningError("UnsupportedSourceBundleMode");
      else modes.set(entry.path, mode);
      entry.resume();
    },
  });
  parser.on("error", (error) => {
    failure = error;
  });
  parser.end(gunzipSync(archive, { maxOutputLength: 34 * 1024 * 1024 }));
  if (failure) throw failure;
  return files.map((file) => {
    const mode = modes.get(file.path);
    if (mode === undefined) throw new PlanningError("MissingSourceBundleMode");
    return { ...file, mode };
  });
}

export async function downloadBundle(bundle: ContentBundle) {
  const configuration = bundleConfiguration();
  const client = new S3Client({
    ...configuration,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
  });
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: configuration.bucket,
        Key: contentBundleKey(bundle.sha256),
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
    const archive = await boundedArchive(response, bundle);
    return { archive, files: verifiedFiles(archive, bundle) };
  } finally {
    client.destroy();
  }
}

async function boundedArchive(
  response: GetObjectCommandOutput,
  bundle: ContentBundle,
) {
  if (
    !response.Body ||
    (response.ContentLength !== undefined &&
      response.ContentLength !== bundle.archiveBytes)
  )
    throw new PlanningError("BundleSizeMismatch");
  const chunks: Uint8Array[] = [];
  let count = 0;
  for await (const chunk of response.Body.transformToWebStream()) {
    count += chunk.length;
    if (count > bundle.archiveBytes) throw new PlanningError("BundleTooLarge");
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  readContentBundle(archive, bundle);
  return archive;
}

export async function saveVerifiedArchive(
  directory: string,
  descriptor: ContentBundle,
  archive: Buffer,
) {
  readContentBundle(archive, descriptor);
  const path = join(directory, `${descriptor.sha256}.tar.gz`);
  try {
    await writePrivate(path, archive);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    readContentBundle(await readPrivate(path), descriptor);
  }
}

export async function savePreparedBundle(
  directory: string,
  files: readonly ContentBundleFile[],
) {
  const prepared = await prepareContentBundle(files);
  readContentBundle(prepared.archive, prepared.descriptor);
  await saveVerifiedArchive(directory, prepared.descriptor, prepared.archive);
  return prepared.descriptor;
}

/** Hash-addressed objects are retained even after recovery or an uncertain PUT. */
export async function publishPreparedBundles(
  directory: string,
  bundles: readonly ContentBundle[],
  publish: boolean,
) {
  const configuration = bundleConfiguration();
  const client = new S3Client({
    ...configuration,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
  });
  try {
    for (const bundle of bundles) {
      const archive = publish
        ? await readPrivate(join(directory, `${bundle.sha256}.tar.gz`))
        : null;
      if (archive !== null) readContentBundle(archive, bundle);
      const key = contentBundleKey(bundle.sha256);
      let missing = false;
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: configuration.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
        await boundedArchive(result, bundle);
      } catch (error) {
        if (!(
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === 404
        ))
          throw error;
        missing = true;
      }
      if (!missing) continue;
      if (archive === null)
        throw new PlanningError("PreparedBundleNotPublished");
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: configuration.bucket,
            Key: key,
            Body: archive,
            ContentType: "application/gzip",
            IfNoneMatch: "*",
          }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
      } catch (error) {
        if (!(
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === 412
        ))
          throw error;
      }
      const verified = await client.send(
        new GetObjectCommand({ Bucket: configuration.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
      await boundedArchive(verified, bundle);
    }
  } finally {
    client.destroy();
  }
}

export async function verifyPreparedContents(
  directory: string,
  image: ExecutionImage,
) {
  for (const table of image.tables) {
    for (const row of table.rows) {
      if (row.after === null || row.before === row.after) continue;
      if (table.name === "workflows") {
        const value = object({
          name: string(),
          description: string().nullable(),
          instruction: string(),
          content_bundle: contentBundleSchema,
          attachments: workflowAttachmentsSchema,
        }).parse(JSON.parse(row.after));
        const files = verifiedFiles(
          await readPrivate(
            join(directory, `${value.content_bundle.sha256}.tar.gz`),
          ),
          value.content_bundle,
        );
        const skill = files.find((file) => {
          return file.path === "SKILL.md";
        });
        const attachments = files.filter((file) => {
          return file.path !== "SKILL.md";
        });
        const expected =
          value.attachments.kind === "empty" ? [] : value.attachments.files;
        if (
          !skill?.content.equals(
            Buffer.from(synthesizeWorkflowSkillMd(value)),
          ) ||
          attachments.length !== expected.length ||
          !expected.every((item) => {
            const file = attachments.find((candidate) => {
              return candidate.path === item.path;
            });
            return (
              file &&
              file.content.length === item.size &&
              sha256(file.content) === item.sha256
            );
          })
        )
          throw new PlanningError("PreparedWorkflowContentMismatch");
      } else if (table.name === "instructions") {
        const value = object({
          content: string(),
          bundle: contentBundleSchema,
        }).parse(JSON.parse(row.after));
        const files = verifiedFiles(
          await readPrivate(join(directory, `${value.bundle.sha256}.tar.gz`)),
          value.bundle,
        );
        if (
          files.length !== 1 ||
          files[0]?.path !== "instructions.md" ||
          !files[0].content.equals(Buffer.from(value.content))
        )
          throw new PlanningError("PreparedPersonalInstructionsMismatch");
      }
    }
  }
}

export async function executionConnection() {
  if (!process.env.DATABASE_URL_FILE)
    throw new PlanningError("OwnerOnlyDATABASE_URL_FILERequired");
  const connection = (await readPrivate(process.env.DATABASE_URL_FILE))
    .toString("utf8")
    .trim();
  if (!connection)
    throw new PlanningError("NonEmptyDatabaseConnectionRequired");
  databaseIdentity(connection);
  return connection;
}
