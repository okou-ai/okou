import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import {
  array,
  boolean,
  number,
  string,
  uuid,
  object as zObject,
  type infer as zInfer,
} from "zod";

import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";

const packageSchema = zObject({
  storageId: uuid(),
  versionId: string(),
  s3Key: string(),
  size: number().int().nonnegative(),
  archiveSize: number().int().nonnegative(),
  fileCount: number().int().nonnegative(),
});
const sourceSchema = zObject({
  id: uuid(),
  orgId: string(),
  ownerUserId: string(),
  fingerprint: string(),
  package: packageSchema.nullable(),
});
const destinationSchema = zObject({
  orgId: string(),
  ownerUserId: string(),
  kind: string().nullable(),
  copied: boolean(),
  package: packageSchema.nullable(),
});
const manifestSchema = zObject({
  version: string(),
  createdAt: string(),
  totalSize: number().int().nonnegative(),
  fileCount: number().int().nonnegative(),
  files: array(
    zObject({
      path: string(),
      hash: string().regex(/^[a-f0-9]{64}$/u),
      size: number().int().nonnegative(),
    }),
  ),
});
class CopyError extends Error {}

function failureClassification(error: unknown): string {
  if (error instanceof CopyError) return error.message;
  return error instanceof Error ? error.name : "Unknown";
}

function readOptions() {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "template-id": { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "100" },
    },
  });
  const templateId =
    values["template-id"] === undefined
      ? null
      : uuid().parse(values["template-id"]);
  const after = values.after === undefined ? null : uuid().parse(values.after);
  const limit = number().int().min(1).max(100).parse(Number(values.limit));
  return { templateId, after, limit, migrate: values.migrate };
}

async function main(): Promise<void> {
  const { templateId, after, limit, migrate } = readOptions();
  const {
    DATABASE_URL_FILE: credential,
    R2_ENDPOINT: endpoint,
    R2_USER_STORAGES_BUCKET_NAME: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = zObject({
    DATABASE_URL_FILE: string().min(1),
    R2_ENDPOINT: string().min(1),
    R2_USER_STORAGES_BUCKET_NAME: string().min(1),
    R2_ACCESS_KEY_ID: string().min(1),
    R2_SECRET_ACCESS_KEY: string().min(1),
  }).parse(process.env);
  const db = postgres((await readFile(credential, "utf8")).trim(), {
    max: 1,
    onnotice() {},
  });
  const s3 = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  const readObject = async (key: string, maxBytes: number): Promise<Buffer> => {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (
      !result.Body ||
      result.ContentLength === undefined ||
      result.ContentLength > maxBytes
    )
      throw new CopyError("InvalidObjectSize");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    if (bytes.length !== result.ContentLength)
      throw new CopyError("IncompleteObject");
    return bytes;
  };
  const readPackage = async (pkg: zInfer<typeof packageSchema>) => {
    const manifest = manifestSchema.parse(
      JSON.parse(
        (
          await readObject(`${pkg.s3Key}/manifest.json`, 8 * 1024 * 1024)
        ).toString("utf8"),
      ),
    );
    if (
      manifest.version !== pkg.versionId ||
      computeContentHashFromHashes(pkg.storageId, manifest.files) !==
        pkg.versionId ||
      manifest.totalSize !== pkg.size ||
      manifest.fileCount !== pkg.fileCount ||
      manifest.files.length !== pkg.fileCount ||
      manifest.files.reduce((sum, file) => {
        return sum + file.size;
      }, 0) !== pkg.size
    )
      throw new CopyError("PackageManifestMismatch");
    const archive = await readObject(
      `${pkg.s3Key}/archive.tar.gz`,
      128 * 1024 * 1024,
    );
    if (archive.length !== pkg.archiveSize)
      throw new CopyError("ArchiveSizeMismatch");
    return { manifest, archive };
  };
  try {
    const sources = array(sourceSchema).parse(
      await db`
      SELECT p.id, p.org_id AS "orgId", p.owner_user_id AS "ownerUserId",
        md5(to_jsonb(p)::text) AS fingerprint,
        CASE WHEN v.id IS NOT NULL THEN jsonb_build_object(
          'storageId', s.id, 'versionId', v.id, 's3Key', v.s3_key,
          'size', v.size, 'archiveSize', v.archive_size, 'fileCount', v.file_count) END AS package
      FROM presentation_templates p
      LEFT JOIN storages s ON s.org_id = p.org_id AND s.user_id = '__org__' AND s.name = 'presentation-template@' || p.id::text
      LEFT JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
      WHERE (${templateId}::uuid IS NULL OR p.id = ${templateId}::uuid)
        AND (${after}::uuid IS NULL OR p.id > ${after}::uuid)
      ORDER BY p.id LIMIT ${limit}`,
    );
    let ready = 0,
      copied = 0,
      existing = 0;
    const attention: { templateId: string; classification: string }[] = [];
    for (const source of sources) {
      try {
        const marker = `Copied presentation-template@${source.id}`;
        const destinations = array(destinationSchema).parse(
          await db`
          SELECT t.org_id AS "orgId", t.owner_user_id AS "ownerUserId", t.manifest->>'kind' AS kind,
            EXISTS (SELECT 1 FROM storage_versions origin WHERE origin.storage_id = s.id AND origin.message = ${marker}) AS copied,
            CASE WHEN v.id IS NOT NULL THEN jsonb_build_object(
              'storageId', s.id, 'versionId', v.id, 's3Key', v.s3_key,
              'size', v.size, 'archiveSize', v.archive_size, 'fileCount', v.file_count) END AS package
          FROM user_templates t
          LEFT JOIN storages s ON s.org_id = t.org_id AND s.user_id = '__org__' AND s.name = 'user-template@' || t.id::text
          LEFT JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
          WHERE t.id = ${source.id}::uuid`,
        );
        const destination = destinations[0];
        if (destination) {
          if (
            destination.orgId !== source.orgId ||
            destination.ownerUserId !== source.ownerUserId ||
            destination.kind !== "presentation" ||
            destination.copied !== true ||
            !destination.package
          )
            throw new CopyError("DestinationConflict");
          await readPackage(destination.package);
          existing++;
          continue;
        }
        if (
          (
            await db`SELECT id FROM storages WHERE org_id = ${source.orgId} AND user_id = '__org__' AND name = 'user-template@' || ${source.id}::text`
          ).length
        )
          throw new CopyError("DestinationStorageConflict");
        const pkg = source.package;
        if (!pkg) throw new CopyError("MissingCommittedSourcePackage");
        const { manifest, archive } = await readPackage(pkg);
        ready++;
        if (!migrate) continue;
        const storageId = randomUUID();
        const s3Prefix = `${source.orgId}/${storageId}`;
        const versionId = computeContentHashFromHashes(
          storageId,
          manifest.files,
        );
        const s3Key = `${s3Prefix}/${versionId}`;
        const newManifest = Buffer.from(
          JSON.stringify({ ...manifest, version: versionId }),
        );
        // Record exact candidate identities before any external mutation so
        // a failed/uncertain attempt can be inspected without guessing a prefix.
        process.stdout.write(
          JSON.stringify({
            templateId: source.id,
            result: "prepared",
            sourceStorageId: pkg.storageId,
            sourceVersionId: pkg.versionId,
            storageId,
            versionId,
            s3Prefix,
          }) + "\n",
        );
        // Fresh, independently owned objects. Never rename, overwrite or delete
        // the source, and never retry an uncertain provider mutation.
        for (const object of [
          {
            name: "archive.tar.gz",
            bytes: archive,
            contentType: "application/gzip",
          },
          {
            name: "manifest.json",
            bytes: newManifest,
            contentType: "application/json",
          },
        ]) {
          const key = `${s3Key}/${object.name}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: object.bytes,
              ContentType: object.contentType,
              IfNoneMatch: "*",
            }),
          );
          if (
            !(await readObject(key, object.bytes.length)).equals(object.bytes)
          )
            throw new CopyError("DestinationObjectMismatch");
        }
        // One statement publishes all three rows, including both sides of the
        // Storage/HEAD foreign keys. A changed source inserts nothing; a unique
        // conflict aborts the statement. No existing destination is overwritten.
        const inserted = await db`
          WITH source AS MATERIALIZED (
            SELECT p.* FROM presentation_templates p
            JOIN storages s ON s.org_id = p.org_id AND s.user_id = '__org__' AND s.name = 'presentation-template@' || p.id::text
            JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
            WHERE p.id = ${source.id}::uuid AND md5(to_jsonb(p)::text) = ${source.fingerprint}
              AND s.id = ${pkg.storageId}::uuid AND v.id = ${pkg.versionId} AND v.s3_key = ${pkg.s3Key}
          ), copied_storage AS (
            INSERT INTO storages (id, org_id, user_id, name, s3_prefix, size, file_count, head_version_id)
            SELECT ${storageId}::uuid, org_id, '__org__', 'user-template@' || id::text,
              ${s3Prefix}, ${pkg.size}, ${pkg.fileCount}, ${versionId} FROM source RETURNING id
          ), copied_version AS (
            INSERT INTO storage_versions (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
            SELECT ${versionId}, id, ${s3Key}, ${pkg.size}, ${pkg.archiveSize}, ${pkg.fileCount}, ${marker}, 'user'
            FROM copied_storage RETURNING id
          )
          INSERT INTO user_templates (id, org_id, owner_user_id, visibility, title,
            source_storage_key, source_filename, manifest, created_by, updated_by, created_at, updated_at)
          SELECT p.id, p.org_id, p.owner_user_id, CASE p.visibility WHEN 'public' THEN 'organization' ELSE 'private' END,
            p.title, p.source_storage_key, p.source_filename,
            jsonb_build_object('kind', 'presentation', 'pageKeys', to_jsonb(p.page_keys)),
            p.created_by, p.updated_by, p.created_at, p.updated_at
          FROM source p CROSS JOIN copied_version RETURNING id`;
        if (inserted.length !== 1) throw new CopyError("SourceChanged");
        copied++;
        process.stdout.write(
          JSON.stringify({
            templateId: source.id,
            result: "copied",
            sourceStorageId: pkg.storageId,
            sourceVersionId: pkg.versionId,
            storageId,
            versionId,
          }) + "\n",
        );
      } catch (error) {
        attention.push({
          templateId: source.id,
          classification: failureClassification(error),
        });
        // Keep any unpublished objects for reconciliation. Do not replay a
        // write whose outcome is unknown, or continue the apply batch.
        if (migrate) break;
      }
    }
    process.stdout.write(
      JSON.stringify({
        mode: migrate ? "copy" : "dry-run",
        scanned: sources.length,
        ready,
        copied,
        existing,
        attention,
        lastTemplateId: sources.at(-1)?.id ?? null,
      }) + "\n",
    );
    if (attention.length) process.exitCode = 2;
  } finally {
    await db.end();
    s3.destroy();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      result: "failed",
      classification: failureClassification(error),
    }) + "\n",
  );
  process.exitCode = 1;
});
