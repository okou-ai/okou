import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  prepareWorkflowAttachmentBundle,
  readLegacyWorkflowAttachments,
  workflowAttachmentHash,
  workflowAttachmentMetadata,
  workflowAttachmentPath,
  verifyWorkflowAttachmentBundle,
} from "@okouai/core/workflow-attachment-bundle";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";

const rowSchema = object({
  id: uuid(),
  orgId: string(),
  agentId: uuid(),
  ownerUserId: string(),
  visibility: zEnum(["private", "public"]),
  updatedAt: string(),
  instructionHash: string(),
  attachments: workflowAttachmentsSchema.nullable(),
  storageId: uuid().nullable(),
  storagePrefix: string().nullable(),
  storageUpdatedAt: string().nullable(),
  unpublished: boolean(),
  versionId: string().nullable(),
  s3Key: string().nullable(),
  pending: boolean(),
});
type Source = zInfer<typeof rowSchema>;
const hashSchema = string().regex(/^[a-f0-9]{64}$/);
const emptySourceSchema = object({
  workflowId: uuid(),
  storageId: uuid(),
  archiveKey: string(),
  archiveSha256: hashSchema,
});
type EmptySource = zInfer<typeof emptySourceSchema>;
const evidenceSchema = discriminatedUnion("kind", [
  object({
    kind: literal("registered"),
    manifestSha256: hashSchema,
    manifestVersion: string(),
  }),
  emptySourceSchema.omit({ archiveSha256: true }).extend({
    kind: literal("unpublished-empty"),
  }),
]);
const readySchema = object({
  source: rowSchema,
  evidence: evidenceSchema,
  archiveSha256: hashSchema,
  files: array(object({ path: string(), size: number(), sha256: string() })),
});
const planSchema = object({
  schemaVersion: literal(2),
  rows: array(readySchema).max(100),
});
class SourceUnavailable extends Error {
  override name = "SourceUnavailable";
}
class SourceChanged extends Error {
  override name = "SourceChanged";
}

async function readReviewedEmptySources(
  path: string | undefined,
  migrate: boolean,
) {
  const emptySources = new Map<string, EmptySource>();
  if (path !== undefined) {
    if (migrate) throw new Error("ApplyUsesReviewedPlanOnly");
    const reviewed = object({
      schemaVersion: literal(1),
      sources: array(emptySourceSchema).max(100),
    }).parse(JSON.parse(await readFile(path, "utf8")));
    for (const source of reviewed.sources) {
      if (emptySources.has(source.workflowId))
        throw new Error("DuplicateEmptySource");
      emptySources.set(source.workflowId, source);
    }
  }
  return emptySources;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      audit: { type: "boolean", default: false },
      "writers-drained": { type: "boolean", default: false },
      "plan-file": { type: "string" },
      "expect-plan-sha256": { type: "string" },
      output: { type: "string" },
      after: { type: "string" },
      "workflow-id": { type: "string" },
      "reviewed-empty-sources": { type: "string" },
      limit: { type: "string", default: "100" },
    },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("InvalidBatchLimit");
  const after = values.after === undefined ? null : uuid().parse(values.after);
  const workflowId =
    values["workflow-id"] === undefined
      ? null
      : uuid().parse(values["workflow-id"]);
  if (
    values.migrate &&
    (!values["writers-drained"] ||
      !values["plan-file"] ||
      !values["expect-plan-sha256"])
  )
    throw new Error("ApplyRequiresReviewedPlanAndDrainedWriters");
  if (values.audit && values.migrate) throw new Error("AuditIsReadOnly");
  const emptySources = await readReviewedEmptySources(
    values["reviewed-empty-sources"],
    values.migrate,
  );
  const credentialPath = process.env.DATABASE_URL_FILE;
  if (!credentialPath) throw new Error("DATABASE_URL_FILERequired");
  const connection = (await readFile(credentialPath, "utf8")).trim();
  const db = postgres(connection, { max: 1, onnotice() {} });
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error("R2ConfigurationRequired");
  const s3 = new S3Client({
    forcePathStyle: true,
    endpoint,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  // Private credentials and provider errors are never included in receipts.
  const readObject = async (key: string): Promise<Buffer> => {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (
      !response.Body ||
      response.ContentLength === undefined ||
      response.ContentLength > 32 * 1024 * 1024
    )
      throw new SourceUnavailable();
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    if (bytes.length !== response.ContentLength) throw new SourceUnavailable();
    return bytes;
  };
  const readUnpublishedEmptySource = async (
    source: Source,
    emptySource?: EmptySource,
  ) => {
    if (
      !source.storageId ||
      !source.unpublished ||
      !source.storagePrefix ||
      !emptySource
    )
      throw new SourceUnavailable();
    const prefix = `${source.storagePrefix.replace(/\/+$/, "")}/`;
    if (
      prefix === "/" ||
      emptySource.workflowId !== source.id ||
      emptySource.storageId !== source.storageId ||
      !emptySource.archiveKey.startsWith(prefix) ||
      !/^[a-f0-9]{64}\/archive\.tar\.gz$/.test(
        emptySource.archiveKey.slice(prefix.length),
      )
    )
      throw new SourceChanged();
    // This is an explicit reviewed source, never a missing-source default.
    // A second object or incomplete listing leaves the source unresolved.
    const listing = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 2,
      }),
    );
    if (
      listing.IsTruncated !== false ||
      listing.Contents?.length !== 1 ||
      listing.Contents[0]?.Key !== emptySource.archiveKey
    )
      throw new SourceChanged();
    const archive = await readObject(emptySource.archiveKey);
    const archiveSha256 = workflowAttachmentHash(archive);
    const files = readLegacyWorkflowAttachments(archive);
    if (
      archiveSha256 !== emptySource.archiveSha256 ||
      files.length !== 0 ||
      listing.Contents[0].Size !== archive.length
    )
      throw new SourceChanged();
    return {
      files,
      metadata: workflowAttachmentMetadata(files),
      archiveSha256,
      evidence: {
        kind: "unpublished-empty" as const,
        workflowId: source.id,
        storageId: source.storageId,
        archiveKey: emptySource.archiveKey,
      },
    };
  };
  const readSource = async (source: Source, emptySource?: EmptySource) => {
    if (!source.storageId || source.pending) throw new SourceUnavailable();
    if (!source.versionId || !source.s3Key) {
      return readUnpublishedEmptySource(source, emptySource);
    }
    const manifestBytes = await readObject(`${source.s3Key}/manifest.json`);
    const manifest = object({
      version: string(),
      files: array(object({ path: string(), hash: string(), size: number() })),
    }).parse(JSON.parse(manifestBytes.toString("utf8")));
    // Some retained manifests have an obsolete version label. The owned
    // Storage's namespaced content hash must still bind their exact file list
    // to HEAD; archive/file integrity checks below remain mandatory. Retire
    // this operator-only compatibility with Epic #42362's legacy sources.
    if (
      manifest.version !== source.versionId &&
      computeContentHashFromHashes(source.storageId, manifest.files) !==
        source.versionId
    )
      throw new SourceChanged();
    const archive = await readObject(`${source.s3Key}/archive.tar.gz`);
    const files = readLegacyWorkflowAttachments(archive);
    const metadata = workflowAttachmentMetadata(files);
    const expected = new Map<
      string,
      { path: string; size: number; sha256: string }
    >();
    // Match the legacy writer's raw-path/hash ordering before normalized paths
    // materialize onto its final filesystem, including supported duplicates.
    for (const file of [...manifest.files].sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
    })) {
      const path = workflowAttachmentPath(file.path);
      if (path !== "SKILL.md")
        expected.set(path, { path, size: file.size, sha256: file.hash });
    }
    const effective = [...expected.values()].sort((a, b) => {
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    if (JSON.stringify(metadata) !== JSON.stringify(effective))
      throw new SourceChanged();
    return {
      files,
      metadata,
      archiveSha256: workflowAttachmentHash(archive),
      evidence: {
        kind: "registered" as const,
        manifestSha256: workflowAttachmentHash(manifestBytes),
        manifestVersion: manifest.version,
      },
    };
  };
  const readRows = async () => {
    return array(rowSchema).parse(
      await db`
      SELECT w.id, w.org_id AS "orgId", w.agent_id AS "agentId", w.owner_user_id AS "ownerUserId",
        w.visibility, w.updated_at::text AS "updatedAt", w.attachments,
        encode(sha256(convert_to(jsonb_build_array(w.instruction)::text, 'UTF8')), 'hex') AS "instructionHash",
        s.id AS "storageId", s.s3_prefix AS "storagePrefix", s.updated_at::text AS "storageUpdatedAt",
        CASE WHEN s.id IS NOT NULL AND s.head_version_id IS NULL THEN
          NOT EXISTS (SELECT 1 FROM storage_versions sv WHERE sv.storage_id=s.id)
          ELSE false END AS unpublished,
        s.head_version_id AS "versionId", v.s3_key AS "s3Key",
        EXISTS (SELECT 1 FROM storage_publication_tokens p WHERE p.org_id = w.org_id AND p.publication_key = 'workflow:' || w.id::text) AS pending
      FROM workflows w LEFT JOIN storages s ON s.org_id = w.org_id AND s.user_id = '__org__' AND s.name = 'custom-skill@' || w.id::text
      LEFT JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
      WHERE w.official_definition_name IS NULL
        AND (${workflowId}::uuid IS NULL OR w.id = ${workflowId}::uuid)
        AND (${after}::uuid IS NULL OR w.id > ${after}::uuid)
      ORDER BY w.id LIMIT ${limit}`,
    );
  };
  const matchesSource = (
    source: Source,
    metadata: ReturnType<typeof workflowAttachmentMetadata>,
  ) => {
    if (source.attachments === null) return false;
    if (source.attachments.kind === "empty") return metadata.length === 0;
    if (
      !source.attachments.objectKey.startsWith(
        `workflow-attachments/${source.orgId}/${source.id}/`,
      )
    ) {
      throw new SourceChanged();
    }
    return (
      JSON.stringify(source.attachments.files) === JSON.stringify(metadata)
    );
  };
  const verifyCurrentPackage = async (source: Source) => {
    if (source.attachments?.kind === "bundle") {
      verifyWorkflowAttachmentBundle(
        await readObject(source.attachments.objectKey),
        source.attachments,
      );
    }
  };
  const audit = async () => {
    const rows = await readRows();
    let verified = 0;
    const attention: { workflowId: string; classification: string }[] = [];
    for (const row of rows) {
      try {
        const source = await readSource(row, emptySources.get(row.id));
        if (!matchesSource(row, source.metadata)) throw new SourceChanged();
        await verifyCurrentPackage(row);
        verified++;
      } catch (error) {
        attention.push({
          workflowId: row.id,
          classification: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
    const counts =
      await db`SELECT count(*)::integer AS total, count(*) FILTER (WHERE attachments IS NULL)::integer AS unconverted FROM workflows WHERE official_definition_name IS NULL`;
    process.stdout.write(
      JSON.stringify({
        mode: "audit",
        counts,
        verified,
        attention,
        lastWorkflowId: rows.at(-1)?.id ?? null,
        rows: rows.map((row) => {
          return {
            workflowId: row.id,
            instructionHash: row.instructionHash,
            attachments: row.attachments,
          };
        }),
      }) + "\n",
    );
    if (attention.length) process.exitCode = 2;
  };
  const dryRun = async () => {
    const rows = await readRows();
    let alreadyCurrent = 0;
    let legacyManifestLabels = 0;
    let reviewedEmptySources = 0;
    const ready: zInfer<typeof readySchema>[] = [];
    const blocked: { workflowId: string; classification: string }[] = [];
    for (const source of rows) {
      try {
        const prepared = await readSource(source, emptySources.get(source.id));
        if (prepared.evidence.kind === "unpublished-empty")
          reviewedEmptySources++;
        else if (prepared.evidence.manifestVersion !== source.versionId)
          legacyManifestLabels++;
        if (matchesSource(source, prepared.metadata)) {
          await verifyCurrentPackage(source);
          alreadyCurrent++;
          continue;
        }
        ready.push({
          source,
          evidence: prepared.evidence,
          archiveSha256: prepared.archiveSha256,
          files: [...prepared.metadata],
        });
      } catch (error) {
        blocked.push({
          workflowId: source.id,
          classification: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
    const plan = {
      schemaVersion: 2 as const,
      rows: ready,
      baseline: rows.map((row) => {
        return { workflowId: row.id, instructionHash: row.instructionHash };
      }),
    };
    const encoded = JSON.stringify(plan, null, 2) + "\n";
    if (values.output)
      await writeFile(values.output, encoded, { mode: 0o600, flag: "wx" });
    process.stdout.write(
      JSON.stringify({
        mode: "dry-run",
        candidates: rows.length,
        ready: ready.length,
        alreadyCurrent,
        legacyManifestLabels,
        reviewedEmptySources,
        empty: ready.filter((row) => {
          return row.files.length === 0;
        }).length,
        blocked,
        lastWorkflowId: rows.at(-1)?.id ?? null,
        planSha256: createHash("sha256").update(encoded).digest("hex"),
        planFile: values.output ?? null,
      }) + "\n",
    );
    if (blocked.length) process.exitCode = 2;
  };
  const migrate = async () => {
    const path = values["plan-file"];
    if (!path) throw new Error("ReviewedPlanRequired");
    const encoded = await readFile(path, "utf8");
    if (workflowAttachmentHash(encoded) !== values["expect-plan-sha256"])
      throw new Error("PlanChecksumMismatch");
    const plan = planSchema.parse(JSON.parse(encoded));
    if (plan.rows.length > limit) throw new Error("PlanExceedsBatchLimit");
    for (const planned of plan.rows) {
      const source = planned.source;
      try {
        const prepared = await readSource(
          source,
          planned.evidence.kind === "unpublished-empty"
            ? { ...planned.evidence, archiveSha256: planned.archiveSha256 }
            : undefined,
        );
        if (
          prepared.archiveSha256 !== planned.archiveSha256 ||
          JSON.stringify(prepared.metadata) !== JSON.stringify(planned.files) ||
          !isDeepStrictEqual(prepared.evidence, planned.evidence)
        )
          throw new SourceChanged();
        const bundle = await prepareWorkflowAttachmentBundle(
          source.orgId,
          source.id,
          prepared.files,
        );
        if (bundle.descriptor.kind === "bundle" && bundle.archive !== null) {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: bundle.descriptor.objectKey,
              Body: bundle.archive,
              ContentType: "application/gzip",
              IfNoneMatch: "*",
            }),
          );
        }
        // Compare the captured descriptor as well as owner/content/HEAD. A
        // non-NULL descriptor can be stale after an outgoing old-API write;
        // supported dual writers publish it atomically with Storage HEAD.
        const unchangedSource =
          prepared.evidence.kind === "registered"
            ? db`EXISTS (SELECT 1 FROM storages s JOIN storage_versions v ON v.storage_id=s.id AND v.id=s.head_version_id WHERE s.id=${source.storageId}::uuid AND s.org_id=w.org_id AND s.user_id='__org__' AND s.name='custom-skill@'||w.id::text AND s.head_version_id=${source.versionId} AND v.s3_key=${source.s3Key})`
            : db`EXISTS (SELECT 1 FROM storages s WHERE s.id=${source.storageId}::uuid AND s.org_id=w.org_id AND s.user_id='__org__' AND s.name='custom-skill@'||w.id::text AND s.s3_prefix=${source.storagePrefix} AND s.updated_at::text=${source.storageUpdatedAt}::text AND s.head_version_id IS NULL AND NOT EXISTS (SELECT 1 FROM storage_versions v WHERE v.storage_id=s.id))`;
        const changed = await db`
          UPDATE workflows w SET attachments = ${db.json(bundle.descriptor)}
          WHERE w.id = ${source.id}::uuid AND w.org_id = ${source.orgId} AND w.agent_id = ${source.agentId}::uuid
            AND w.owner_user_id = ${source.ownerUserId} AND w.visibility = ${source.visibility}
            AND w.official_definition_name IS NULL
            AND w.attachments IS NOT DISTINCT FROM ${source.attachments === null ? null : db.json(source.attachments)}::jsonb
            AND w.updated_at::text = ${source.updatedAt}::text
            AND encode(sha256(convert_to(jsonb_build_array(w.instruction)::text, 'UTF8')), 'hex') = ${source.instructionHash}
            AND ${unchangedSource}
            AND NOT EXISTS (SELECT 1 FROM storage_publication_tokens p WHERE p.org_id = w.org_id AND p.publication_key = 'workflow:' || w.id::text)
          RETURNING w.id`;
        process.stdout.write(
          JSON.stringify({
            workflowId: source.id,
            result: changed.length === 1 ? "converted" : "skipped-changed",
            sourceKind: prepared.evidence.kind,
            sourceVersionId: source.versionId,
            instructionHash: source.instructionHash,
            attachments: bundle.descriptor,
          }) + "\n",
        );
      } catch (error) {
        // Keep uncertain uploads. This preparation never deletes objects or
        // retries a write after an unknown commit result.
        process.stdout.write(
          JSON.stringify({
            workflowId: source.id,
            result: "attention",
            classification: error instanceof Error ? error.name : "Unknown",
          }) + "\n",
        );
        process.exitCode = 2;
        break;
      }
    }
  };
  try {
    if (values.audit) await audit();
    else if (values.migrate) await migrate();
    else await dryRun();
  } finally {
    await db.end();
    s3.destroy();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      result: "failed",
      classification: error instanceof Error ? error.name : "Unknown",
    }) + "\n",
  );
  process.exitCode = 1;
});
