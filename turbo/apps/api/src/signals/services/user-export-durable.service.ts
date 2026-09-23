import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import { createSHA256 } from "hash-wasm";
import { z } from "zod";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { exportJobs } from "@okouai/db/schema/export-job";
import {
  userExportEntries,
  userExportParts,
} from "@okouai/db/schema/user-export-entry";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import {
  serializeUserExportZipEnd,
  updateUserExportCrc32,
  userExportZipEntryLayout,
} from "../../lib/user-export-zip";
import { writeDb$, type Db } from "../external/db";
import {
  completeMultipartS3Upload,
  createMultipartS3Upload,
  generatePresignedGetUrl,
  putS3Object,
  putS3ObjectReturningEtag,
  readS3ObjectRange,
  s3ObjectHead,
} from "../external/s3";
import {
  claimBackgroundJob,
  completeBackgroundJob,
  failBackgroundJob,
  retryBackgroundJob,
  yieldBackgroundJob,
  type ClaimedBackgroundJob,
} from "./background-job.service";
import { collectUserExportSourceStep$ } from "./user-export-source.service";
import { assembleUserExportStep$ } from "./user-export-assembly.service";
import { userExportReadyEmail } from "./user-export.service";
import { settleIncludingAbort } from "../utils";
import {
  authorizeUserExportPage$,
  currentUserExportMemberships,
  lockUserExportPublicationAuthority,
} from "./user-export-authorization.service";

const log = logger("service:user-export-durable");
const PART_BYTES = 16 * 1024 * 1024;
const SCAN_BYTES = 4 * 1024 * 1024;
const SCAN_BATCH_SIZE = 100;
const INVOCATION_BUDGET_MS = 20_000;
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_FAILURES = 6;
const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const stateSchema = z.object({
  phase: z
    .enum([
      "collect",
      "scan",
      "inventory",
      "manifest",
      "init-upload",
      "assemble",
      "authorize",
      "publish",
      "notify",
    ])
    .default("collect"),
  manifestPageCount: z.number().int().nonnegative().default(0),
  manifestHashState: z.string().optional(),
  manifestSha256: z.string().optional(),
  collectedAt: z.string().optional(),
  source: z.record(z.string(), z.unknown()).default({}),
  entryCount: z.number().int().nonnegative().default(0),
  cursor: z.number().int().nonnegative().default(0),
  localSize: z.number().int().nonnegative().default(0),
  centralSize: z.number().int().nonnegative().default(0),
  totalSize: z.number().int().nonnegative().default(0),
  partNumber: z.number().int().positive().default(1),
  zipOffset: z.number().int().nonnegative().default(0),
  pendingKey: z.string().optional(),
  pendingSize: z.number().int().nonnegative().default(0),
  uploadId: z.string().default(""),
  resultKey: z.string().default(""),
});
type ExportState = z.infer<typeof stateSchema>;
interface Runtime {
  readonly db: Db;
  readonly bucket: string;
  readonly job: ClaimedBackgroundJob;
  readonly state: ExportState;
}

interface EntryPosition {
  readonly ordinal: number;
  readonly localOffset: number;
  readonly centralOffset: number;
}

function entryCondition(jobId: string, ordinal: number) {
  return and(
    eq(userExportEntries.jobId, jobId),
    eq(userExportEntries.ordinal, ordinal),
  );
}
function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}
function contentKey(job: ClaimedBackgroundJob, bytes: Buffer): string {
  return `exports/${job.userId}/${job.id}/staging/${createHash("sha256").update(bytes).digest("hex")}`;
}
async function saveState(
  runtime: Runtime,
  state: ExportState,
  signal: AbortSignal,
): Promise<boolean> {
  return await yieldBackgroundJob(
    runtime.db,
    { job: runtime.job, checkpoint: state },
    signal,
  );
}

/** Commit one collection step: pin its snapshots, record its entries, run the job. */
async function commitCollectedEntries(
  args: {
    readonly db: Db;
    readonly job: ClaimedBackgroundJob;
    readonly entries: readonly (typeof userExportEntries.$inferInsert)[];
    readonly next: ExportState;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { db, job, entries, next } = args;
  return await db.transaction(async (tx) => {
    if (!(await yieldBackgroundJob(tx, { job, checkpoint: next }, signal))) {
      return false;
    }
    for (const entry of entries) {
      if (entry.metadata?.sourceKind !== "chat-snapshot") {
        continue;
      }
      const threadId = entry.metadata.threadId;
      if (typeof threadId !== "string") {
        throw new Error("Export snapshot has no thread identity");
      }
      // Pin while holding the current head against replacement. GC observes
      // either the live head or this committed export reference, never a gap.
      const [head] = await tx
        .select({ id: chatEventSnapshots.id })
        .from(chatEventSnapshots)
        .where(
          and(
            eq(chatEventSnapshots.chatThreadId, threadId),
            eq(chatEventSnapshots.archiveSchemaVersion, 7),
            eq(chatEventSnapshots.objectKey, entry.sourceKey),
          ),
        )
        .limit(1)
        .for("share");
      signal.throwIfAborted();
      if (!head) {
        throw new Error(
          "Export snapshot changed before its durable pin; retry collection",
        );
      }
    }
    if (entries.length > 0) {
      await tx.insert(userExportEntries).values([...entries]);
      signal.throwIfAborted();
    }
    await tx
      .update(exportJobs)
      .set({ status: "running" })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "pending")));
    signal.throwIfAborted();
    return true;
  });
}

const collectStep$ = command(
  async ({ get, set }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const result = await set(
      collectUserExportSourceStep$,
      {
        db,
        bucket,
        userId: job.userId,
        orgId: job.orgId,
        checkpoint: state.source,
      },
      signal,
    );
    signal.throwIfAborted();
    const entries: (typeof userExportEntries.$inferInsert)[] = [];
    for (const [index, entry] of result.entries.entries()) {
      const sourceKey =
        entry.content === undefined
          ? entry.sourceKey
          : contentKey(job, entry.content);
      if (!sourceKey) {
        throw new Error("Export source has no durable bytes");
      }
      // Bytes we author are already in memory: their size, ETag, and digests
      // are known here, so they never need a read-back pass in `scan`.
      if (entry.content !== undefined) {
        const etag = await get(
          putS3ObjectReturningEtag(
            bucket,
            sourceKey,
            entry.content,
            "application/octet-stream",
            signal,
          ),
        );
        signal.throwIfAborted();
        const size = entry.content.length;
        userExportZipEntryLayout({
          path: entry.path,
          size,
          localHeaderOffset: 0,
        });
        entries.push({
          jobId: job.id,
          ordinal: state.entryCount + index,
          path: entry.path,
          sourceKey,
          size,
          scannedBytes: size,
          crc32: updateUserExportCrc32(0, entry.content),
          ready: true,
          metadata: {
            ...entry.metadata,
            etag,
            // `contentKey` derives the staging key from this same digest.
            sha256: sourceKey.slice(sourceKey.lastIndexOf("/") + 1),
          },
        });
        continue;
      }
      const head = await get(s3ObjectHead(bucket, sourceKey, signal));
      signal.throwIfAborted();
      if (
        head.kind !== "found" ||
        head.contentLength === undefined ||
        !head.etag
      ) {
        throw new Error(
          "Export source is missing its immutable storage revision",
        );
      }
      const expectedBytes = entry.metadata?.expectedBytes;
      if (
        typeof expectedBytes === "number" &&
        expectedBytes !== head.contentLength
      ) {
        throw new Error(
          "Export source size does not match its storage version",
        );
      }
      userExportZipEntryLayout({
        path: entry.path,
        size: head.contentLength,
        localHeaderOffset: 0,
      });
      entries.push({
        jobId: job.id,
        ordinal: state.entryCount + index,
        path: entry.path,
        sourceKey,
        size: head.contentLength,
        metadata: { ...entry.metadata, etag: head.etag },
      });
    }
    const next: ExportState = {
      ...state,
      source: result.checkpoint,
      entryCount: state.entryCount + entries.length,
      phase: result.done ? "scan" : "collect",
      collectedAt: result.done ? nowDate().toISOString() : state.collectedAt,
    };
    return await commitCollectedEntries({ db, job, entries, next }, signal);
  },
);

/**
 * Entries hashed while their bytes were in memory need no read-back. Only their
 * archive offsets are still unknown, and those follow from path and size alone,
 * so a run of them advances in one step instead of one step each.
 */
function placePrehashedEntries(
  rows: readonly (typeof userExportEntries.$inferSelect)[],
  state: ExportState,
):
  | {
      readonly placed: readonly EntryPosition[];
      readonly next: ExportState;
    }
  | undefined {
  const placed: EntryPosition[] = [];
  let localSize = state.localSize;
  let centralSize = state.centralSize;
  for (const row of rows) {
    if (!row.ready || stringMetadata(row.metadata, "sha256") === undefined) {
      break;
    }
    const layout = userExportZipEntryLayout({
      path: row.path,
      size: row.size,
      localHeaderOffset: localSize,
    });
    placed.push({
      ordinal: row.ordinal,
      localOffset: localSize,
      centralOffset: centralSize,
    });
    localSize += layout.localHeaderSize + row.size;
    centralSize += layout.centralHeaderSize;
  }
  if (placed.length === 0) {
    return undefined;
  }
  return {
    placed,
    next: {
      ...state,
      cursor: state.cursor + placed.length,
      localSize,
      centralSize,
    },
  };
}

async function commitPlacedEntries(
  args: {
    readonly db: Db;
    readonly job: ClaimedBackgroundJob;
    readonly placed: readonly EntryPosition[];
    readonly next: ExportState;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { db, job, placed, next } = args;
  return await db.transaction(async (tx) => {
    if (!(await yieldBackgroundJob(tx, { job, checkpoint: next }, signal))) {
      return false;
    }
    for (const position of placed) {
      await tx
        .update(userExportEntries)
        .set({
          localOffset: position.localOffset,
          centralOffset: position.centralOffset,
        })
        .where(entryCondition(job.id, position.ordinal));
      signal.throwIfAborted();
    }
    return true;
  });
}

const scanStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const rows = await db
      .select()
      .from(userExportEntries)
      .where(
        and(
          eq(userExportEntries.jobId, job.id),
          gte(userExportEntries.ordinal, state.cursor),
        ),
      )
      .orderBy(asc(userExportEntries.ordinal))
      .limit(SCAN_BATCH_SIZE);
    signal.throwIfAborted();
    const [entry] = rows;
    if (!entry) {
      return await saveState(
        runtime,
        { ...state, phase: "inventory", cursor: 0 },
        signal,
      );
    }
    const advanced = placePrehashedEntries(rows, state);
    if (advanced) {
      return await commitPlacedEntries({ db, job, ...advanced }, signal);
    }
    const etag = stringMetadata(entry.metadata, "etag");
    if (!etag) {
      throw new Error("User export source has no immutable revision");
    }
    const bytes = await get(
      readS3ObjectRange(
        {
          bucket,
          key: entry.sourceKey,
          offset: entry.scannedBytes,
          length: Math.min(SCAN_BYTES, entry.size - entry.scannedBytes),
          etag,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    const hasher = await createSHA256();
    signal.throwIfAborted();
    const savedHash = stringMetadata(entry.metadata, "hashState");
    if (savedHash) {
      hasher.load(Buffer.from(savedHash, "base64"));
    }
    hasher.update(bytes);
    const scannedBytes = entry.scannedBytes + bytes.length;
    const ready = scannedBytes === entry.size;
    const metadata = { ...entry.metadata };
    if (ready) {
      const sha256 = hasher.digest("hex");
      const expected = stringMetadata(metadata, "expectedSha256");
      if (expected && expected !== sha256) {
        throw new Error("Export source checksum mismatch");
      }
      delete metadata.hashState;
      metadata.sha256 = sha256;
    } else {
      metadata.hashState = Buffer.from(hasher.save()).toString("base64");
    }
    const layout = userExportZipEntryLayout({
      path: entry.path,
      size: entry.size,
      localHeaderOffset: state.localSize,
    });
    const next: ExportState = ready
      ? {
          ...state,
          cursor: state.cursor + 1,
          localSize: state.localSize + layout.localHeaderSize + entry.size,
          centralSize: state.centralSize + layout.centralHeaderSize,
        }
      : state;
    return await db.transaction(async (tx) => {
      if (!(await yieldBackgroundJob(tx, { job, checkpoint: next }, signal))) {
        return false;
      }
      await tx
        .update(userExportEntries)
        .set({
          scannedBytes,
          crc32: updateUserExportCrc32(entry.crc32, bytes),
          metadata,
          ready,
          localOffset: state.localSize,
          centralOffset: state.centralSize,
        })
        .where(entryCondition(job.id, entry.ordinal));
      signal.throwIfAborted();
      return true;
    });
  },
);

/** The manifest is paged too: a large account never creates one giant JSON value. */
const inventoryStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const rows = await db
      .select()
      .from(userExportEntries)
      .where(
        and(
          eq(userExportEntries.jobId, job.id),
          gt(userExportEntries.ordinal, state.cursor - 1),
        ),
      )
      .orderBy(asc(userExportEntries.ordinal))
      .limit(100);
    signal.throwIfAborted();
    // entryCount stays fixed until the inventory is complete, excluding inventory pages themselves.
    const sources = rows.filter((row) => {
      return row.ordinal < state.entryCount;
    });
    const done =
      sources.length < 100 ||
      (sources.at(-1)?.ordinal ?? -1) + 1 >= state.entryCount;
    const path = `manifest/files-${state.cursor}.jsonl`;
    const bytes = Buffer.from(
      sources
        .map((row) => {
          return JSON.stringify({
            path: row.path,
            size: row.size,
            sha256: row.metadata.sha256,
            ...Object.fromEntries(
              Object.entries(row.metadata).filter(([key]) => {
                return !["etag", "hashState", "sha256"].includes(key);
              }),
            ),
          });
        })
        .join("\n") + "\n",
    );
    const sourceKey = contentKey(job, bytes);
    await get(
      putS3Object(bucket, sourceKey, bytes, "application/x-ndjson", signal),
    );
    signal.throwIfAborted();
    const head = await get(s3ObjectHead(bucket, sourceKey, signal));
    signal.throwIfAborted();
    if (head.kind !== "found" || !head.etag) {
      throw new Error("Export inventory was not stored");
    }
    const layout = userExportZipEntryLayout({
      path,
      size: bytes.length,
      localHeaderOffset: state.localSize,
    });
    const pageNumber = state.manifestPageCount;
    const hasher = await createSHA256();
    signal.throwIfAborted();
    if (state.manifestHashState) {
      hasher.load(Buffer.from(state.manifestHashState, "base64"));
    }
    hasher.update(bytes);
    const manifestHashState = done
      ? undefined
      : Buffer.from(hasher.save()).toString("base64");
    const manifestSha256 = done ? hasher.digest("hex") : undefined;
    const next: ExportState = {
      ...state,
      cursor: state.cursor + sources.length,
      localSize: state.localSize + layout.localHeaderSize + bytes.length,
      centralSize: state.centralSize + layout.centralHeaderSize,
      phase: done ? "manifest" : "inventory",
      entryCount: done ? state.entryCount + pageNumber + 1 : state.entryCount,
      manifestPageCount: pageNumber + 1,
      manifestHashState,
      manifestSha256,
    };
    return await db.transaction(async (tx) => {
      if (!(await yieldBackgroundJob(tx, { job, checkpoint: next }, signal))) {
        return false;
      }
      await tx.insert(userExportEntries).values({
        jobId: job.id,
        ordinal: state.entryCount + pageNumber,
        path,
        sourceKey,
        size: bytes.length,
        scannedBytes: bytes.length,
        crc32: updateUserExportCrc32(0, bytes),
        ready: true,
        localOffset: state.localSize,
        centralOffset: state.centralSize,
        metadata: { etag: head.etag },
      });
      signal.throwIfAborted();
      return true;
    });
  },
);

const manifestStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const bytes = Buffer.from(
      JSON.stringify(
        {
          formatVersion: 4,
          chatEventSchemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          userId: job.userId,
          requestOrgId: job.orgId,
          startedAt: state.source.startedAt,
          collectedAt: state.collectedAt,
          accessibleOrgIds: state.source.orgIds,
          filesManifest: {
            pageCount: state.manifestPageCount,
            pageSize: 100,
            pathPattern: "manifest/files-{pageStart}.jsonl",
            sha256: state.manifestSha256,
            algorithm: "sha256-concatenated-pages",
          },
        },
        null,
        2,
      ) + "\n",
    );
    const path = "export-manifest.json";
    const sourceKey = contentKey(job, bytes);
    await get(
      putS3Object(bucket, sourceKey, bytes, "application/json", signal),
    );
    signal.throwIfAborted();
    const head = await get(s3ObjectHead(bucket, sourceKey, signal));
    signal.throwIfAborted();
    if (head.kind !== "found" || !head.etag) {
      throw new Error("Export manifest was not stored");
    }
    const layout = userExportZipEntryLayout({
      path,
      size: bytes.length,
      localHeaderOffset: state.localSize,
    });
    return await db.transaction(async (tx) => {
      if (
        !(await yieldBackgroundJob(
          tx,
          {
            job,
            checkpoint: {
              ...state,
              phase: "init-upload",
              entryCount: state.entryCount + 1,
              localSize:
                state.localSize + layout.localHeaderSize + bytes.length,
              centralSize: state.centralSize + layout.centralHeaderSize,
            },
          },
          signal,
        ))
      ) {
        return false;
      }
      await tx.insert(userExportEntries).values({
        jobId: job.id,
        ordinal: state.entryCount,
        path,
        sourceKey,
        size: bytes.length,
        scannedBytes: bytes.length,
        crc32: updateUserExportCrc32(0, bytes),
        ready: true,
        localOffset: state.localSize,
        centralOffset: state.centralSize,
        metadata: { etag: head.etag },
      });
      signal.throwIfAborted();
      return true;
    });
  },
);

const initUploadStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { bucket, job, state } = runtime;
    const footer = serializeUserExportZipEnd({
      entryCount: state.entryCount,
      centralDirectoryOffset: state.localSize,
      centralDirectorySize: state.centralSize,
    });
    const totalSize = state.localSize + state.centralSize + footer.length;
    if (!Number.isSafeInteger(totalSize) || totalSize > PART_BYTES * 10_000) {
      throw new Error("Export exceeds the 156 GiB multipart archive limit");
    }
    const resultKey = `exports/${job.userId}/${job.id}.zip`;
    const uploadId = await get(
      createMultipartS3Upload(
        bucket,
        resultKey,
        "application/zip",
        {
          "export-job-id": job.id,
          "export-format": "3",
          "export-size": String(totalSize),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    return await saveState(
      runtime,
      { ...state, phase: "assemble", totalSize, resultKey, uploadId },
      signal,
    );
  },
);

const assembleStep$ = command(
  async ({ set }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const result = await set(
      assembleUserExportStep$,
      { db, bucket, jobId: job.id, userId: job.userId, state },
      signal,
    );
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      if (
        !(await yieldBackgroundJob(
          tx,
          {
            job,
            checkpoint: {
              ...state,
              ...result.state,
              phase: result.done ? "authorize" : "assemble",
              cursor: result.done ? 0 : state.cursor,
            },
          },
          signal,
        ))
      ) {
        return false;
      }
      if (result.part) {
        await tx
          .insert(userExportParts)
          .values({ jobId: job.id, ...result.part })
          .onConflictDoUpdate({
            target: [userExportParts.jobId, userExportParts.partNumber],
            set: { etag: result.part.etag },
          });
      }
      signal.throwIfAborted();
      return true;
    });
  },
);

const authorizeStep$ = command(
  async ({ set }, runtime: Runtime, signal: AbortSignal) => {
    const { db, job, state } = runtime;
    const result = await set(
      authorizeUserExportPage$,
      { db, jobId: job.id, userId: job.userId, cursor: state.cursor },
      signal,
    );
    signal.throwIfAborted();
    return await saveState(
      runtime,
      {
        ...state,
        cursor: result.cursor,
        phase: result.done ? "publish" : "authorize",
      },
      signal,
    );
  },
);

const publishStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const head = await get(s3ObjectHead(bucket, state.resultKey, signal));
    signal.throwIfAborted();
    if (head.kind === "missing") {
      const parts = await db
        .select({
          partNumber: userExportParts.partNumber,
          etag: userExportParts.etag,
        })
        .from(userExportParts)
        .where(eq(userExportParts.jobId, job.id))
        .orderBy(asc(userExportParts.partNumber));
      signal.throwIfAborted();
      if (
        parts.length !== Math.ceil(state.totalSize / PART_BYTES) ||
        parts.some((part, index) => {
          return part.partNumber !== index + 1;
        })
      ) {
        throw new Error("Export multipart receipt inventory is incomplete");
      }
      await get(
        completeMultipartS3Upload(
          bucket,
          state.resultKey,
          state.uploadId,
          parts,
          signal,
        ),
      );
      signal.throwIfAborted();
    } else if (
      head.contentLength !== state.totalSize ||
      head.metadata["export-job-id"] !== job.id ||
      head.metadata["export-format"] !== "3" ||
      head.metadata["export-size"] !== String(state.totalSize)
    ) {
      throw new Error("Completed export does not match its durable byte plan");
    }
    const orgIds = await get(currentUserExportMemberships(job.userId, signal));
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      await lockUserExportPublicationAuthority(
        tx,
        { jobId: job.id, userId: job.userId, orgIds },
        signal,
      );
      signal.throwIfAborted();
      if (
        !(await yieldBackgroundJob(
          tx,
          { job, checkpoint: { ...state, phase: "notify" } },
          signal,
        ))
      ) {
        return false;
      }
      const published = await tx
        .update(exportJobs)
        .set({
          status: "completed",
          s3Key: state.resultKey,
          completedAt: nowDate(),
          expiresAt: new Date(
            nowDate().getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
          ),
          error: null,
        })
        .where(
          and(
            eq(exportJobs.id, job.id),
            eq(exportJobs.userId, job.userId),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        )
        .returning({ id: exportJobs.id });
      signal.throwIfAborted();
      if (published.length !== 1) {
        throw new Error("Export owner or result is no longer publishable");
      }
      return true;
    });
  },
);

const notifyStep$ = command(
  async ({ get }, runtime: Runtime, signal: AbortSignal) => {
    const { db, bucket, job, state } = runtime;
    const [published] = await db
      .select({ expiresAt: exportJobs.expiresAt })
      .from(exportJobs)
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "completed")))
      .limit(1);
    signal.throwIfAborted();
    if (!published?.expiresAt) {
      throw new Error("Export result expired before notification");
    }
    const downloadUrl = await get(
      generatePresignedGetUrl(
        bucket,
        state.resultKey,
        "okou-data-export.zip",
        true,
      ),
    );
    signal.throwIfAborted();
    const email = await get(
      userExportReadyEmail(
        { db, bucket },
        {
          userId: job.userId,
          downloadUrl,
          expiresAt: published.expiresAt,
          artifactCount: 0,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      await assertErasureSubjectWritable(tx, [
        { subjectKind: "user", subjectId: job.userId },
      ]);
      if (!(await completeBackgroundJob(tx, { job }, signal))) {
        return false;
      }
      await tx.insert(emailOutbox).values(email);
      signal.throwIfAborted();
      return true;
    });
  },
);

const executeStep$ = command(
  async ({ set }, runtime: Runtime, signal: AbortSignal): Promise<boolean> => {
    switch (runtime.state.phase) {
      case "collect": {
        return await set(collectStep$, runtime, signal);
      }
      case "scan": {
        return await set(scanStep$, runtime, signal);
      }
      case "inventory": {
        return await set(inventoryStep$, runtime, signal);
      }
      case "manifest": {
        return await set(manifestStep$, runtime, signal);
      }
      case "init-upload": {
        return await set(initUploadStep$, runtime, signal);
      }
      case "assemble": {
        return await set(assembleStep$, runtime, signal);
      }
      case "authorize": {
        return await set(authorizeStep$, runtime, signal);
      }
      case "publish": {
        return await set(publishStep$, runtime, signal);
      }
      case "notify": {
        return await set(notifyStep$, runtime, signal);
      }
    }
  },
);

/** Persist the outcome even when the work signal aborted or its receipt was lost. */
async function finishUserExportAttempt(
  db: Db,
  job: ClaimedBackgroundJob,
  work: Promise<boolean>,
): Promise<void> {
  const result = await settleIncludingAbort(work);
  if (!result.ok) {
    // The independent cleanup deadline can record a retry after the request aborts.
    const cleanupSignal = AbortSignal.timeout(5000);
    const error =
      result.error instanceof Error
        ? result.error.message
        : "Export step failed";
    log.warn("Export step will recover from its committed checkpoint", {
      jobId: job.id,
      error,
    });
    if (job.failureCount + 1 >= MAX_FAILURES) {
      await db.transaction(async (tx) => {
        if (await failBackgroundJob(tx, { job, error }, cleanupSignal)) {
          await tx
            .update(exportJobs)
            .set({
              status: "failed",
              error: "Data export could not be completed. Please try again.",
              completedAt: nowDate(),
            })
            .where(
              and(
                eq(exportJobs.id, job.id),
                inArray(exportJobs.status, ["pending", "running"]),
              ),
            );
        }
      });
    } else {
      await retryBackgroundJob(
        db,
        {
          job,
          error,
          availableAt: new Date(
            nowDate().getTime() +
              Math.min(600_000, 15_000 * 2 ** job.failureCount),
          ),
        },
        cleanupSignal,
      );
    }
  }
}

/** Cron is the durable wakeup; request waitUntil only reduces initial latency. */
export const executeDurableUserExportWork$ = command(
  async (
    { set },
    args: { readonly jobId?: string; readonly maxSteps?: number },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    const started = performance.now();
    let processed = 0;
    while (
      processed < (args.maxSteps ?? 200) &&
      performance.now() - started < INVOCATION_BUDGET_MS
    ) {
      signal.throwIfAborted();
      const job = await claimBackgroundJob(
        db,
        { jobId: args.jobId, kind: "user-export", handlerVersion: 1 },
        signal,
      );
      signal.throwIfAborted();
      if (!job) {
        break;
      }
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      ]);
      await finishUserExportAttempt(
        db,
        job,
        (async () => {
          const [owner] = await db
            .select({ id: exportJobs.id })
            .from(exportJobs)
            .where(
              and(
                eq(exportJobs.id, job.id),
                eq(exportJobs.userId, job.userId),
                eq(exportJobs.executionMode, "durable-v1"),
              ),
            )
            .limit(1);
          attemptSignal.throwIfAborted();
          if (
            !owner ||
            nowDate().getTime() - job.createdAt.getTime() > MAX_JOB_AGE_MS
          ) {
            throw new Error(
              "Export owner is unavailable or the job has expired",
            );
          }
          return await set(
            executeStep$,
            {
              db,
              bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
              job,
              state: stateSchema.parse(job.checkpoint),
            },
            attemptSignal,
          );
        })(),
      );
      signal.throwIfAborted();
      processed += 1;
    }
    return { processed };
  },
);
