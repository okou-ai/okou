#!/usr/bin/env tsx

/**
 * Automation -> workflow migration: SKILL.md volume preseed.
 *
 * Companion data migration for the automation -> workflow cutover
 * (issue vm0-ai/vm0#19959). The cutover SQL migration (shipped separately)
 * creates a private `zero_workflows` row per `automations` row, REUSING the
 * automation's id as the workflow id. A workflow's skill content lives in an
 * R2 volume named `custom-skill@{workflowId}` — object-storage I/O that SQL
 * cannot do, and the runtime silently skips missing skill volumes, so the
 * volume must exist BEFORE the migrated trigger can fire.
 *
 * Because the future workflow id equals the automation id, the volume name is
 * predictable ahead of the cutover. This script uploads, for every automation:
 *
 *   custom-skill@{automation.id}/
 *     archive.tar.gz   (contains the synthesized SKILL.md)
 *     manifest.json
 *
 * plus the matching `storages` / `storage_versions` rows — mirroring
 * `uploadVolumeServerSide$` (apps/api storage-volume-upload.service.ts).
 * Until the cutover migration runs, these volumes are unreferenced and inert.
 *
 * The SKILL.md body follows the rules agreed in #19959:
 *   - name: slug-normalized automation name (`wf-{id8}` fallback), which MUST
 *     match the name the cutover SQL writes on the workflow row;
 *   - description: automation description (slug fallback handled by core);
 *   - instruction: automation instruction, with a non-blank
 *     `append_system_prompt` appended under an "## Additional instructions"
 *     heading.
 *
 * The script is idempotent (version ids are content hashes) and defaults to
 * dry-run. It only mutates when `--migrate` is passed. Re-running after an
 * automation was edited uploads a new head version. Run it:
 *   1. any time before the cutover release (bulk of the work),
 *   2. once more right before the release,
 *   3. once more after the release as a sweep for rows created/edited in the
 *      gap (the cutover blocks further legacy writes).
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts
 *   pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts --migrate
 *   pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts --migrate --org=org_xxx
 *
 * Environment (same as 007):
 *   DATABASE_URL                  — Required
 *   R2_USER_STORAGES_BUCKET_NAME  — Required (workflow volume bucket)
 *   R2_ACCOUNT_ID                 — Required (unless S3_ENDPOINT is set)
 *   R2_ACCESS_KEY_ID              — Required
 *   R2_SECRET_ACCESS_KEY          — Required
 *   S3_ENDPOINT                   — Optional (overrides the R2 account endpoint)
 *   S3_REGION                     — Optional (defaults to "auto")
 *   S3_FORCE_PATH_STYLE           — Optional ("true" | "false")
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  getCustomSkillStorageName,
  synthesizeWorkflowSkillMd,
  VOLUME_ORG_USER_ID,
} from "@okouai/core";
import { automations } from "@okouai/db/schema/automation";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    org: { type: "string" },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;
const SINGLE_ORG_ID = args.org;

const SKILL_FILENAME = "SKILL.md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle>;

interface AutomationRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly description: string | null;
  readonly instruction: string;
  readonly appendSystemPrompt: string | null;
}

interface Stats {
  automations: number;
  volumesCreated: number;
  volumesUpdated: number;
  volumesUpToDate: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Shared migration rules (MUST stay in sync with the cutover SQL migration)
// ---------------------------------------------------------------------------

/**
 * Slug-normalize an automation name into a workflow name.
 *
 * Mirrors the workflow slug rule (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`, min 2):
 * lowercase, illegal characters to `-`, collapse runs, trim edge hyphens.
 * Falls back to `wf-` + the first 8 chars of the automation id when the
 * normalized result is shorter than 2 characters. As of 2026-07-03 all 519
 * production names are already valid slugs, so this is expected to be a no-op
 * safety net for rows created before the cutover.
 */
function normalizeWorkflowName(name: string, automationId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 2 ? slug : `wf-${automationId.slice(0, 8)}`;
}

/**
 * Merge a legacy `append_system_prompt` into the workflow instruction body.
 * Applied only when the appendix is non-blank after trimming; the explicit
 * heading preserves the "this was a system-level supplement" boundary.
 */
function mergeInstruction(
  instruction: string,
  appendSystemPrompt: string | null,
): string {
  if (!appendSystemPrompt || appendSystemPrompt.trim().length === 0) {
    return instruction;
  }
  return `${instruction}\n\n## Additional instructions\n\n${appendSystemPrompt}`;
}

// ---------------------------------------------------------------------------
// Content hashing (mirrors api-contracts storage-content-hash.ts)
// ---------------------------------------------------------------------------

interface FileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

function computeStorageVersionId(
  storageId: string,
  files: readonly FileEntry[],
): string {
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }
  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  return createHash("sha256")
    .update(`storage:${storageId}\n${entries.join("\n")}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Minimal tar writer (ustar; companion of the reader in 007). The version id
// is derived from file content hashes, not archive bytes, so deterministic
// header fields (mtime 0, root ownership) keep re-runs byte-stable too.
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

function tarOctal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, "0");
  return Buffer.from(`${text}\0`, "ascii");
}

function tarHeader(path: string, size: number): Buffer {
  if (Buffer.byteLength(path, "utf8") > 100) {
    throw new Error(`tar path too long: ${path}`);
  }
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(path, 0, "utf8"); // name
  tarOctal(0o644, 8).copy(header, 100); // mode
  tarOctal(0, 8).copy(header, 108); // uid
  tarOctal(0, 8).copy(header, 116); // gid
  tarOctal(size, 12).copy(header, 124); // size
  tarOctal(0, 12).copy(header, 136); // mtime
  header.fill(" ", 148, 156); // chksum placeholder
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii"); // magic
  header.write("00", 263, "ascii"); // version
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148,
  );
  return header;
}

function createTarGz(
  files: readonly { readonly path: string; readonly content: Buffer }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    blocks.push(tarHeader(file.path, file.content.length));
    blocks.push(file.content);
    const remainder = file.content.length % TAR_BLOCK_SIZE;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
    }
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2)); // end-of-archive
  return gzipSync(Buffer.concat(blocks));
}

// ---------------------------------------------------------------------------
// S3 / R2 client (mirrors apps/api/src/signals/external/s3.ts construction)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createR2Client(): S3Client {
  const endpoint =
    process.env.S3_ENDPOINT ??
    `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}

async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function verifyObjectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

// ---------------------------------------------------------------------------
// Volume upsert (mirrors apps/api storage-volume-upload.service.ts)
// ---------------------------------------------------------------------------

interface PreseedResult {
  readonly status: "created" | "updated" | "up-to-date";
}

async function preseedAutomationVolume(
  db: Db,
  client: S3Client,
  bucket: string,
  automation: AutomationRow,
): Promise<PreseedResult> {
  const workflowName = normalizeWorkflowName(automation.name, automation.id);
  const skillMd = synthesizeWorkflowSkillMd({
    name: workflowName,
    description: automation.description,
    instruction: mergeInstruction(
      automation.instruction,
      automation.appendSystemPrompt,
    ),
  });
  const content = Buffer.from(skillMd, "utf8");
  const fileEntries: readonly FileEntry[] = [
    {
      path: SKILL_FILENAME,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    },
  ];

  const storageName = getCustomSkillStorageName(automation.id);
  const s3Prefix = `${automation.orgId}/volume/${storageName}`;

  const [existing] = await db
    .select({ id: storages.id, headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, automation.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
      ),
    )
    .limit(1);

  if (existing) {
    const versionId = computeStorageVersionId(existing.id, fileEntries);
    if (existing.headVersionId === versionId) {
      return { status: "up-to-date" };
    }
  }

  if (DRY_RUN) {
    return { status: existing ? "updated" : "created" };
  }

  const timestamp = new Date();
  const [storage] = await db
    .insert(storages)
    .values({
      userId: VOLUME_ORG_USER_ID,
      orgId: automation.orgId,
      name: storageName,
      s3Prefix,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      set: { updatedAt: timestamp },
    })
    .returning({ id: storages.id, s3Prefix: storages.s3Prefix });
  if (!storage) {
    throw new Error(`Failed to upsert storage ${storageName}`);
  }

  const versionId = computeStorageVersionId(storage.id, fileEntries);
  const s3Key = `${storage.s3Prefix}/${versionId}`;
  const manifest = {
    version: versionId,
    createdAt: timestamp.toISOString(),
    totalSize: content.length,
    fileCount: fileEntries.length,
    files: fileEntries,
  };
  const archive = createTarGz([{ path: SKILL_FILENAME, content }]);

  await putObject(
    client,
    bucket,
    `${s3Key}/archive.tar.gz`,
    archive,
    "application/gzip",
  );
  await putObject(
    client,
    bucket,
    `${s3Key}/manifest.json`,
    JSON.stringify(manifest),
    "application/json",
  );
  await verifyObjectExists(client, bucket, `${s3Key}/archive.tar.gz`);

  await db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key,
        size: content.length,
        archiveSize: archive.length,
        fileCount: fileEntries.length,
        message: "automation -> workflow preseed (#19959)",
        createdBy: "user",
      })
      .onConflictDoUpdate({
        target: storageVersions.id,
        set: { archiveSize: archive.length },
      });
    await tx
      .update(storages)
      .set({
        headVersionId: versionId,
        size: content.length,
        fileCount: fileEntries.length,
        updatedAt: timestamp,
      })
      .where(eq(storages.id, storage.id));
  });

  return { status: existing ? "updated" : "created" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const bucket = requireEnv("R2_USER_STORAGES_BUCKET_NAME");
  const client = createR2Client();
  const sql = postgres(databaseUrl, { max: 4 });
  const db = drizzle(sql);

  console.log(
    `automation -> workflow preseed | ${DRY_RUN ? "DRY-RUN (pass --migrate to execute)" : "EXECUTE"}${SINGLE_ORG_ID ? ` | org=${SINGLE_ORG_ID}` : ""}`,
  );

  const rows: AutomationRow[] = await db
    .select({
      id: automations.id,
      orgId: automations.orgId,
      name: automations.name,
      description: automations.description,
      instruction: automations.instruction,
      appendSystemPrompt: automations.appendSystemPrompt,
    })
    .from(automations)
    .where(SINGLE_ORG_ID ? eq(automations.orgId, SINGLE_ORG_ID) : undefined)
    .orderBy(asc(automations.createdAt));

  const stats: Stats = {
    automations: rows.length,
    volumesCreated: 0,
    volumesUpdated: 0,
    volumesUpToDate: 0,
    errors: 0,
  };

  for (const automation of rows) {
    try {
      const result = await preseedAutomationVolume(
        db,
        client,
        bucket,
        automation,
      );
      if (result.status === "created") {
        stats.volumesCreated += 1;
      } else if (result.status === "updated") {
        stats.volumesUpdated += 1;
      } else {
        stats.volumesUpToDate += 1;
      }
      if (result.status !== "up-to-date") {
        console.log(
          `  [${result.status}] ${automation.id} (${automation.orgId})`,
        );
      }
    } catch (error) {
      stats.errors += 1;
      console.error("  [error]", automation.id, error);
    }
  }

  console.log(
    `done | automations=${stats.automations} created=${stats.volumesCreated} updated=${stats.volumesUpdated} up-to-date=${stats.volumesUpToDate} errors=${stats.errors}`,
  );

  await sql.end();
  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

await main();
