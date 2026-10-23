import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import { z } from "zod";
import {
  prepareWorkflowAttachmentBundle,
  readLegacyWorkflowAttachments,
  workflowAttachmentHash,
  workflowAttachmentMetadata,
  verifyWorkflowAttachmentBundle,
} from "@okouai/core/workflow-attachment-bundle";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";

const rowSchema = z.object({
  id: z.uuid(),
  orgId: z.string(),
  agentId: z.uuid(),
  ownerUserId: z.string(),
  visibility: z.enum(["private", "public"]),
  updatedAt: z.string(),
  instructionHash: z.string(),
  storageId: z.uuid().nullable(),
  versionId: z.string().nullable(),
  s3Key: z.string().nullable(),
  pending: z.boolean(),
});
type Source = z.infer<typeof rowSchema>;
const readySchema = z.object({
  source: rowSchema,
  archiveSha256: z.string(),
  files: z.array(
    z.object({ path: z.string(), size: z.number(), sha256: z.string() }),
  ),
});
const planSchema = z.object({
  schemaVersion: z.literal(1),
  rows: z.array(readySchema).max(100),
});
class SourceUnavailable extends Error {
  override name = "SourceUnavailable";
}
class SourceChanged extends Error {
  override name = "SourceChanged";
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
      limit: { type: "string", default: "100" },
    },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("InvalidBatchLimit");
  const after =
    values.after === undefined ? null : z.uuid().parse(values.after);
  const workflowId =
    values["workflow-id"] === undefined
      ? null
      : z.uuid().parse(values["workflow-id"]);
  if (
    values.migrate &&
    (!values["writers-drained"] ||
      !values["plan-file"] ||
      !values["expect-plan-sha256"])
  )
    throw new Error("ApplyRequiresReviewedPlanAndDrainedWriters");
  if (values.audit && values.migrate) throw new Error("AuditIsReadOnly");
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
  const readSource = async (source: Source) => {
    if (
      !source.storageId ||
      !source.versionId ||
      !source.s3Key ||
      source.pending
    )
      throw new SourceUnavailable();
    const manifest = z
      .object({
        version: z.string(),
        files: z.array(
          z.object({ path: z.string(), hash: z.string(), size: z.number() }),
        ),
      })
      .parse(
        JSON.parse(
          (await readObject(`${source.s3Key}/manifest.json`)).toString("utf8"),
        ),
      );
    if (manifest.version !== source.versionId) throw new SourceChanged();
    const archive = await readObject(`${source.s3Key}/archive.tar.gz`);
    const files = readLegacyWorkflowAttachments(archive);
    const metadata = workflowAttachmentMetadata(files);
    const expected = manifest.files
      .filter((file) => {
        return file.path.replace(/^\.\//u, "") !== "SKILL.md";
      })
      .map((file) => {
        return {
          path: file.path.replace(/^\.\//u, ""),
          size: file.size,
          sha256: file.hash,
        };
      })
      .sort((a, b) => {
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
    if (JSON.stringify(metadata) !== JSON.stringify(expected))
      throw new SourceChanged();
    return { files, metadata, archiveSha256: workflowAttachmentHash(archive) };
  };
  const audit = async () => {
    const rows = z
      .array(
        z.object({
          id: z.uuid(),
          orgId: z.string(),
          attachments: workflowAttachmentsSchema.nullable(),
          instructionHash: z.string(),
        }),
      )
      .parse(
        await db`
      SELECT id, org_id AS "orgId", attachments, encode(sha256(convert_to(jsonb_build_array(instruction)::text, 'UTF8')), 'hex') AS "instructionHash"
      FROM workflows WHERE official_definition_name IS NULL AND (${workflowId}::uuid IS NULL OR id = ${workflowId}::uuid) AND (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT ${limit}`,
      );
    let verified = 0;
    const attention: { workflowId: string; classification: string }[] = [];
    for (const row of rows) {
      try {
        if (row.attachments === null) throw new SourceUnavailable();
        if (row.attachments.kind === "bundle") {
          if (
            !row.attachments.objectKey.startsWith(
              `workflow-attachments/${row.orgId}/${row.id}/`,
            )
          ) {
            throw new SourceChanged();
          }
          verifyWorkflowAttachmentBundle(
            await readObject(row.attachments.objectKey),
            row.attachments,
          );
        }
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
    const rows = z.array(rowSchema).parse(
      await db`
      SELECT w.id, w.org_id AS "orgId", w.agent_id AS "agentId", w.owner_user_id AS "ownerUserId",
        w.visibility, w.updated_at::text AS "updatedAt",
        encode(sha256(convert_to(jsonb_build_array(w.instruction)::text, 'UTF8')), 'hex') AS "instructionHash",
        s.id AS "storageId", s.head_version_id AS "versionId", v.s3_key AS "s3Key",
        EXISTS (SELECT 1 FROM storage_publication_tokens p WHERE p.org_id = w.org_id AND p.publication_key = 'workflow:' || w.id::text) AS pending
      FROM workflows w LEFT JOIN storages s ON s.org_id = w.org_id AND s.user_id = '__org__' AND s.name = 'custom-skill@' || w.id::text
      LEFT JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
      WHERE w.official_definition_name IS NULL AND w.attachments IS NULL
        AND (${workflowId}::uuid IS NULL OR w.id = ${workflowId}::uuid)
        AND (${after}::uuid IS NULL OR w.id > ${after}::uuid)
      ORDER BY w.id LIMIT ${limit}`,
    );
    const ready: z.infer<typeof readySchema>[] = [];
    const blocked: { workflowId: string; classification: string }[] = [];
    for (const source of rows) {
      try {
        const prepared = await readSource(source);
        ready.push({
          source,
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
    const plan = { schemaVersion: 1 as const, rows: ready };
    const encoded = JSON.stringify(plan, null, 2) + "\n";
    if (values.output)
      await writeFile(values.output, encoded, { mode: 0o600, flag: "wx" });
    process.stdout.write(
      JSON.stringify({
        mode: "dry-run",
        candidates: rows.length,
        ready: ready.length,
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
        const prepared = await readSource(source);
        if (
          prepared.archiveSha256 !== planned.archiveSha256 ||
          JSON.stringify(prepared.metadata) !== JSON.stringify(planned.files)
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
        // NULL CAS owns conversion. A current dual writer atomically sets the
        // descriptor with HEAD; waiting behind it rechecks the changed row.
        const changed = await db`
          UPDATE workflows w SET attachments = ${db.json(bundle.descriptor)}
          WHERE w.id = ${source.id}::uuid AND w.org_id = ${source.orgId} AND w.agent_id = ${source.agentId}::uuid
            AND w.owner_user_id = ${source.ownerUserId} AND w.visibility = ${source.visibility}
            AND w.official_definition_name IS NULL AND w.attachments IS NULL AND w.updated_at::text = ${source.updatedAt}::text
            AND encode(sha256(convert_to(jsonb_build_array(w.instruction)::text, 'UTF8')), 'hex') = ${source.instructionHash}
            AND EXISTS (SELECT 1 FROM storages s JOIN storage_versions v ON v.storage_id = s.id AND v.id = s.head_version_id WHERE s.id = ${source.storageId}::uuid AND s.org_id = w.org_id AND s.name = 'custom-skill@' || w.id::text AND s.head_version_id = ${source.versionId} AND v.s3_key = ${source.s3Key})
            AND NOT EXISTS (SELECT 1 FROM storage_publication_tokens p WHERE p.org_id = w.org_id AND p.publication_key = 'workflow:' || w.id::text)
          RETURNING w.id`;
        process.stdout.write(
          JSON.stringify({
            workflowId: source.id,
            result: changed.length === 1 ? "converted" : "skipped-changed",
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
