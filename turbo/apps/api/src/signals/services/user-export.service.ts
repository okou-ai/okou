import { createHash } from "node:crypto";
import { ZipArchive } from "archiver";
import { command, computed, type Computed } from "ccstate";
import { and, asc, desc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
  isChatEventUserMessageTextType,
} from "@okouai/api-contracts/contracts/chat-events";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import type {
  UserExportJob,
  UserExportStartResponse,
  UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import {
  getInstructionsStorageName,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { exportJobs } from "@okouai/db/schema/export-job";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPublicationProvenance } from "@okouai/db/schema/pi-memory-publication-provenance";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { workflows } from "@okouai/db/schema/workflow";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { extractFilesFromTarGz } from "../../lib/tar";
import { db$, writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import {
  downloadManifest,
  downloadS3Buffer,
  downloadS3BufferWithMaxBytes,
  generatePresignedGetUrl,
  putS3Object,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  tapError,
} from "../utils";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  EMAIL_PUBLIC_BRAND,
} from "./email-common.service";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  type SessionHistoryBlobEncoding,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "./session-history-decompression";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalArchivedChatEventContent,
  canonicalArchivedChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { readCurrentChatEventHistory } from "./chat-event-history.service";
import { loadWorkflowVolumeFiles } from "./workflow-volume.service";
import { projectPiSessionJsonlForExport } from "@okouai/pi-agent-runtime/api";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const EXPORT_DOWNLOAD_EXPIRY_SECONDS = PRESIGNED_URL_TTL_SECONDS;
const EXPORT_DOWNLOAD_EXPIRY_MS = EXPORT_DOWNLOAD_EXPIRY_SECONDS * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const DATA_EXPORT_FILENAME = "okou-data-export.zip";
const log = logger("service:user-export");

type ExportJobStatus = UserExportJob["status"];
type ActiveExportJobStatus = Extract<ExportJobStatus, "pending" | "running">;

interface StartUserExportArgs {
  readonly userId: string;
  readonly orgId: string;
}

type StartUserExportResult =
  | {
      readonly kind: "accepted";
      readonly jobId: string;
      readonly status: ActiveExportJobStatus;
      readonly shouldExecute: boolean;
    }
  | { readonly kind: "rate_limited" };

interface ExecuteUserExportJobArgs {
  readonly jobId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ZipEntry {
  readonly path: string;
  readonly content: Buffer | string;
}

interface CollectedData {
  readonly zipEntries: readonly ZipEntry[];
}

interface ExportRuntime {
  readonly db: Db;
  readonly bucket: string;
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkEmailProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}

interface VolumeFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

interface ExportTextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly userMessage?: UserMessageDocument;
  readonly createdAt: string;
}

const EXPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const satisfies readonly ExportJobStatus[];

const ACTIVE_EXPORT_JOB_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly ActiveExportJobStatus[];

function isExportJobStatus(status: string): status is ExportJobStatus {
  return EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function exportJobStatus(status: string): ExportJobStatus {
  if (isExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected export job status: ${status}`);
}

function isActiveExportJobStatus(
  status: string,
): status is ActiveExportJobStatus {
  return ACTIVE_EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function activeExportJobStatus(status: string): ActiveExportJobStatus {
  if (isActiveExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected active export job status: ${status}`);
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

function displayName(user: ClerkEmailProfile): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

export function userExportStatus(userId: string) {
  return computed(async (get): Promise<UserExportStatusResponse> => {
    const db = get(db$);
    const [latestJob] = await db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        expiresAt: exportJobs.expiresAt,
        s3Key: exportJobs.s3Key,
        error: exportJobs.error,
      })
      .from(exportJobs)
      .where(eq(exportJobs.userId, userId))
      .orderBy(desc(exportJobs.createdAt))
      .limit(1);

    const now = nowDate();
    const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_MS);
    const [recentCompleted] = await db
      .select({ completedAt: exportJobs.completedAt })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          eq(exportJobs.status, "completed"),
          gt(exportJobs.completedAt, rateLimitCutoff),
        ),
      )
      .limit(1);

    const [activeJob] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    const hasActiveJob = Boolean(activeJob);
    const canExport = !recentCompleted && !hasActiveJob;
    const nextExportAt = recentCompleted?.completedAt
      ? new Date(
          recentCompleted.completedAt.getTime() + RATE_LIMIT_MS,
        ).toISOString()
      : null;

    if (!latestJob) {
      return { job: null, canExport: true, nextExportAt: null };
    }

    let downloadUrl: string | null = null;
    if (
      latestJob.status === "completed" &&
      latestJob.s3Key &&
      latestJob.expiresAt &&
      latestJob.expiresAt > now
    ) {
      downloadUrl = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          latestJob.s3Key,
          DATA_EXPORT_FILENAME,
          true,
        ),
      );
    }

    return {
      job: {
        id: latestJob.id,
        status: exportJobStatus(latestJob.status),
        createdAt: latestJob.createdAt.toISOString(),
        completedAt: latestJob.completedAt?.toISOString() ?? null,
        expiresAt: latestJob.expiresAt?.toISOString() ?? null,
        downloadUrl,
        error: latestJob.error,
      },
      canExport,
      nextExportAt,
    };
  });
}

export const startUserExport$ = command(
  async (
    { set },
    args: StartUserExportArgs,
    signal: AbortSignal,
  ): Promise<StartUserExportResult> => {
    const db = set(writeDb$);

    const [activeJob] = await db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
      })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, args.userId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (activeJob) {
      return {
        kind: "accepted",
        jobId: activeJob.id,
        status: activeExportJobStatus(activeJob.status),
        shouldExecute: false,
      };
    }

    const rateLimitCutoff = new Date(nowDate().getTime() - RATE_LIMIT_MS);
    const [recentCompleted] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, args.userId),
          eq(exportJobs.status, "completed"),
          gt(exportJobs.completedAt, rateLimitCutoff),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (recentCompleted) {
      return { kind: "rate_limited" };
    }

    const [job] = await db
      .insert(exportJobs)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        status: "pending",
        publicBrand: PUBLIC_BRAND,
        createdAt: nowDate(),
      })
      .returning({ id: exportJobs.id });
    signal.throwIfAborted();

    if (!job) {
      throw new Error("Failed to create export job");
    }

    return {
      kind: "accepted",
      jobId: job.id,
      status: "pending",
      shouldExecute: true,
    };
  },
);

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/]+/g, "-").trim() || "unnamed";
}

function normalizeExportFilePath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => {
      return part.length > 0 && part !== ".";
    });

  if (
    parts.some((part) => {
      return part === "..";
    })
  ) {
    throw new Error(`Invalid export file path: ${path}`);
  }

  return parts.join("/") || "file";
}

function scopedExportPath(args: {
  readonly scope: string;
  readonly name: string;
  readonly id: string;
  readonly filePath: string;
}): string {
  const folder = `${sanitizePathSegment(args.name)}-${args.id}`;
  return `${args.scope}/${folder}/${normalizeExportFilePath(args.filePath)}`;
}

function loadStorageVolumeFiles(
  runtime: ExportRuntime,
  args: {
    readonly orgId: string;
    readonly storageName: string;
  },
  signal: AbortSignal,
): Computed<Promise<readonly VolumeFile[]>> {
  return computed(async (get) => {
    const [storage] = await runtime.db
      .select({ id: storages.id, headVersionId: storages.headVersionId })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, args.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, args.storageName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!storage?.headVersionId) {
      return [];
    }

    return await get(
      loadStorageVersionFiles(
        runtime,
        {
          storageId: storage.id,
          headVersionId: storage.headVersionId,
        },
        signal,
      ),
    );
  });
}

function loadStorageVersionFiles(
  runtime: ExportRuntime,
  args: {
    readonly storageId: string;
    readonly headVersionId: string | null;
  },
  signal: AbortSignal,
): Computed<Promise<readonly VolumeFile[]>> {
  return computed(async (get) => {
    if (!args.headVersionId) {
      return [];
    }

    const [version] = await runtime.db
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, args.headVersionId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!version) {
      return [];
    }

    const manifest = await get(downloadManifest(runtime.bucket, version.s3Key));
    signal.throwIfAborted();

    const filesList = manifest.files.map((file) => {
      return {
        path: normalizeExportFilePath(file.path),
        size: file.size,
      };
    });
    const archiveBuffer = await get(
      downloadS3Buffer(runtime.bucket, `${version.s3Key}/archive.tar.gz`),
    );
    signal.throwIfAborted();

    const contents = extractFilesFromTarGz(
      archiveBuffer,
      filesList.map((file) => {
        return file.path;
      }),
    );
    const sizeByPath = new Map(
      filesList.map((file) => {
        return [file.path, file.size];
      }),
    );

    return contents.map((file) => {
      const path = normalizeExportFilePath(file.path);
      return {
        path,
        content: file.content,
        size: sizeByPath.get(path) ?? Buffer.byteLength(file.content, "utf8"),
      };
    });
  });
}

function collectAgentInstructionFiles(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async (get) => {
    const entries: ZipEntry[] = [];

    const composes = await runtime.db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        name: agents.name,
      })
      .from(agents)
      .where(eq(agents.owner, userId))
      .orderBy(asc(agents.orgId), asc(agents.name));
    signal.throwIfAborted();

    for (const compose of composes) {
      const files = await get(
        loadStorageVolumeFiles(
          runtime,
          {
            orgId: compose.orgId,
            storageName: getInstructionsStorageName(compose.name),
          },
          signal,
        ),
      );
      signal.throwIfAborted();

      for (const file of files) {
        entries.push({
          path: scopedExportPath({
            scope: "agents",
            name: compose.name,
            id: compose.id,
            filePath: file.path,
          }),
          content: file.content,
        });
      }
    }

    return { entries, count: entries.length };
  });
}

function collectWorkflowFiles(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async (get) => {
    const entries: ZipEntry[] = [];

    const workflowRows = await runtime.db
      .select({
        id: workflows.id,
        orgId: workflows.orgId,
        name: workflows.name,
        createdAt: workflows.createdAt,
      })
      .from(workflows)
      .where(eq(workflows.ownerUserId, userId))
      .orderBy(
        asc(workflows.orgId),
        asc(workflows.name),
        asc(workflows.createdAt),
      );
    signal.throwIfAborted();

    for (const workflow of workflowRows) {
      const files =
        (await get(
          loadWorkflowVolumeFiles({
            orgId: workflow.orgId,
            workflowId: workflow.id,
          }),
        )) ?? [];
      signal.throwIfAborted();

      for (const file of files) {
        entries.push({
          path: scopedExportPath({
            scope: "workflows",
            name: workflow.name,
            id: workflow.id,
            filePath: file.path,
          }),
          content: file.content,
        });
      }
    }

    return { entries, count: entries.length };
  });
}

function collectMemoryFiles(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async (get) => {
    const entries: ZipEntry[] = [];

    const memoryStorages = await runtime.db
      .select({
        id: storages.id,
        orgId: storages.orgId,
        headVersionId: storages.headVersionId,
        fileCount: storages.fileCount,
      })
      .from(storages)
      .where(
        and(
          eq(storages.userId, userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
        ),
      )
      .orderBy(asc(storages.orgId));
    signal.throwIfAborted();

    for (const memoryStorage of memoryStorages) {
      if (memoryStorage.fileCount === 0) {
        continue;
      }

      const files = await get(
        loadStorageVersionFiles(
          runtime,
          {
            storageId: memoryStorage.id,
            headVersionId: memoryStorage.headVersionId,
          },
          signal,
        ),
      );
      signal.throwIfAborted();

      for (const file of files) {
        entries.push({
          path: `memory/${sanitizePathSegment(
            memoryStorage.orgId,
          )}/${normalizeExportFilePath(file.path)}`,
          content: file.content,
        });
      }
    }

    return { entries, count: entries.length };
  });
}

function collectPiMemoryStage1Candidates(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async () => {
    const rows = await runtime.db
      .select({
        memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
        orgId: piMemoryStage1Candidates.orgId,
        piSessionId: piMemoryStage1Candidates.piSessionId,
        sourceRunId: piMemoryStage1Candidates.sourceRunId,
        sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
        sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
        eligibleAt: piMemoryStage1Candidates.eligibleAt,
        status: piMemoryStage1Candidates.status,
        retryAt: piMemoryStage1Candidates.retryAt,
        retryCount: piMemoryStage1Candidates.retryCount,
        lastErrorClass: piMemoryStage1Candidates.lastErrorClass,
        rawMemory: piMemoryStage1Candidates.rawMemory,
        rolloutSummary: piMemoryStage1Candidates.rolloutSummary,
        rolloutSlug: piMemoryStage1Candidates.rolloutSlug,
        generatedAt: piMemoryStage1Candidates.generatedAt,
        lastSelectedSourceHistoryHash:
          piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
        usageCount: piMemoryStage1Candidates.usageCount,
        lastUsedAt: piMemoryStage1Candidates.lastUsedAt,
        createdAt: piMemoryStage1Candidates.createdAt,
        updatedAt: piMemoryStage1Candidates.updatedAt,
      })
      .from(piMemoryStage1Candidates)
      .where(eq(piMemoryStage1Candidates.userId, userId))
      .orderBy(
        asc(piMemoryStage1Candidates.orgId),
        asc(piMemoryStage1Candidates.memoryStorageId),
        asc(piMemoryStage1Candidates.piSessionId),
      );
    signal.throwIfAborted();
    return {
      entries:
        rows.length === 0
          ? []
          : [
              {
                path: "memory/stage1-candidates.json",
                content: JSON.stringify(rows, null, 2),
              },
            ],
      count: rows.length,
    };
  });
}

function collectPiMemoryPhase2Jobs(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async () => {
    const rows = await runtime.db
      .select({
        memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
        orgId: piMemoryPhase2Jobs.orgId,
        userId: piMemoryPhase2Jobs.userId,
        status: piMemoryPhase2Jobs.status,
        inputRevision: piMemoryPhase2Jobs.inputRevision,
        completedRevision: piMemoryPhase2Jobs.completedRevision,
        reconciliationRevision: piMemoryPhase2Jobs.reconciliationRevision,
        claimedRevision: piMemoryPhase2Jobs.claimedRevision,
        claimedBaseVersionId: piMemoryPhase2Jobs.claimedBaseVersionId,
        leaseExpiresAt: piMemoryPhase2Jobs.leaseExpiresAt,
        retryCount: piMemoryPhase2Jobs.retryCount,
        retryAt: piMemoryPhase2Jobs.retryAt,
        lastErrorClass: piMemoryPhase2Jobs.lastErrorClass,
        lastSucceededAt: piMemoryPhase2Jobs.lastSucceededAt,
        claimedSelectedCount: piMemoryPhase2Jobs.claimedSelectedCount,
        claimedSelectedUtf8Bytes: piMemoryPhase2Jobs.claimedSelectedUtf8Bytes,
        lastObservedHeadVersionId: piMemoryPhase2Jobs.lastObservedHeadVersionId,
        conflictCount: piMemoryPhase2Jobs.conflictCount,
        lastConflictAt: piMemoryPhase2Jobs.lastConflictAt,
        lastConflictingHeadVersionId:
          piMemoryPhase2Jobs.lastConflictingHeadVersionId,
        lastPublishedVersionId: piMemoryPhase2Jobs.lastPublishedVersionId,
        lastPublishedAt: piMemoryPhase2Jobs.lastPublishedAt,
        createdAt: piMemoryPhase2Jobs.createdAt,
        updatedAt: piMemoryPhase2Jobs.updatedAt,
      })
      .from(piMemoryPhase2Jobs)
      .where(eq(piMemoryPhase2Jobs.userId, userId))
      .orderBy(
        asc(piMemoryPhase2Jobs.orgId),
        asc(piMemoryPhase2Jobs.memoryStorageId),
      );
    signal.throwIfAborted();
    return {
      entries:
        rows.length === 0
          ? []
          : [
              {
                path: "memory/phase2-jobs.json",
                content: JSON.stringify(rows, null, 2),
              },
            ],
      count: rows.length,
    };
  });
}

function collectPiMemoryPublicationProvenance(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }>
> {
  return computed(async () => {
    const rows = await runtime.db
      .select({
        id: piMemoryPublicationProvenance.id,
        memoryStorageId: piMemoryPublicationProvenance.memoryStorageId,
        orgId: piMemoryPublicationProvenance.orgId,
        userId: piMemoryPublicationProvenance.userId,
        claimedRevision: piMemoryPublicationProvenance.claimedRevision,
        inputRevision: piMemoryPublicationProvenance.inputRevision,
        reconciliationRevision:
          piMemoryPublicationProvenance.reconciliationRevision,
        selectionDigest: piMemoryPublicationProvenance.selectionDigest,
        selectedCount: piMemoryPublicationProvenance.selectedCount,
        selectedUtf8Bytes: piMemoryPublicationProvenance.selectedUtf8Bytes,
        baseVersionId: piMemoryPublicationProvenance.baseVersionId,
        preparedVersionId: piMemoryPublicationProvenance.preparedVersionId,
        observedHeadVersionId:
          piMemoryPublicationProvenance.observedHeadVersionId,
        writer: piMemoryPublicationProvenance.writer,
        outcome: piMemoryPublicationProvenance.outcome,
        size: piMemoryPublicationProvenance.size,
        archiveSize: piMemoryPublicationProvenance.archiveSize,
        fileCount: piMemoryPublicationProvenance.fileCount,
        createdAt: piMemoryPublicationProvenance.createdAt,
      })
      .from(piMemoryPublicationProvenance)
      .where(eq(piMemoryPublicationProvenance.userId, userId))
      .orderBy(
        asc(piMemoryPublicationProvenance.orgId),
        asc(piMemoryPublicationProvenance.memoryStorageId),
        asc(piMemoryPublicationProvenance.createdAt),
        asc(piMemoryPublicationProvenance.id),
      );
    signal.throwIfAborted();
    return {
      entries:
        rows.length === 0
          ? []
          : [
              {
                path: "memory/phase2-publication-provenance.json",
                content: JSON.stringify(rows, null, 2),
              },
            ],
      count: rows.length,
    };
  });
}

interface ResolveSessionHistoryArgs {
  readonly sessionId: string;
  readonly hash: string | null;
  readonly encoding: string | null;
  readonly rawSize: number | null;
  readonly encodedSize: number | null;
}

function resolveSessionHistory(
  runtime: ExportRuntime,
  args: ResolveSessionHistoryArgs,
  signal: AbortSignal,
): Computed<Promise<Buffer>> {
  return computed(async (get) => {
    if (!args.hash) {
      throw new Error(
        `Session history invariant violated: agent session "${args.sessionId}" has no blob hash`,
      );
    }

    const normalizedEncoding = normalizeSessionHistoryBlobEncoding(
      args.encoding,
    );
    const rawSize = args.rawSize && args.rawSize > 0 ? args.rawSize : undefined;
    const encodedSize =
      args.encodedSize && args.encodedSize > 0 ? args.encodedSize : undefined;
    const key = resumeSessionHistoryBlobKey(args.hash, normalizedEncoding);
    const result = await get(
      loadSessionHistoryBlob(runtime, {
        encoding: normalizedEncoding,
        encodedSize,
        hash: args.hash,
        key,
        rawSize,
      }),
    );
    signal.throwIfAborted();

    return result;
  });
}

function loadSessionHistoryBlob(
  runtime: ExportRuntime,
  args: {
    readonly encodedSize: number | undefined;
    readonly encoding: SessionHistoryBlobEncoding;
    readonly hash: string;
    readonly key: string;
    readonly rawSize: number | undefined;
  },
): Computed<Promise<Buffer>> {
  return computed(async (get) => {
    const encodedBuffer = await get(
      downloadS3BufferWithMaxBytes(
        runtime.bucket,
        args.key,
        args.encodedSize ?? RESUME_SESSION_HISTORY_MAX_BYTES,
      ),
    );
    const rawBuffer = await decodeSessionHistoryBuffer({
      encodedBuffer,
      encoding: args.encoding,
      key: args.key,
      maxRawBytes: args.rawSize ?? RESUME_SESSION_HISTORY_MAX_BYTES,
    });
    return verifySessionHistoryBuffer(args.hash, rawBuffer, args.rawSize);
  });
}

async function decodeSessionHistoryBuffer(args: {
  readonly encodedBuffer: Buffer;
  readonly encoding: SessionHistoryBlobEncoding;
  readonly key: string;
  readonly maxRawBytes: number;
}): Promise<Buffer> {
  switch (args.encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return await gunzipSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encodedBuffer,
        args.maxRawBytes,
      );
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return await unzstdSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encodedBuffer,
        args.maxRawBytes,
      );
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return args.encodedBuffer;
    }
  }
}

function verifySessionHistoryBuffer(
  hash: string,
  buffer: Buffer,
  expectedSize: number | undefined,
): Buffer {
  if (expectedSize !== undefined && buffer.length !== expectedSize) {
    throw new Error(
      `session history size mismatch: expected ${expectedSize} bytes, got ${buffer.length} bytes`,
    );
  }
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== hash) {
    throw new Error(`session history hash mismatch: expected ${hash}`);
  }
  return buffer;
}

function collectConversationMessages(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<
  Promise<{
    readonly entries: readonly ZipEntry[];
    readonly threadCount: number;
    readonly sessionHistoryCount: number;
  }>
> {
  return computed(async (get) => {
    const entries: ZipEntry[] = [];
    let threadCount = 0;
    let sessionHistoryCount = 0;

    const threads = await runtime.db
      .select({ id: chatThreads.id, createdAt: chatThreads.createdAt })
      .from(chatThreads)
      .where(eq(chatThreads.userId, userId))
      .orderBy(asc(chatThreads.createdAt));
    signal.throwIfAborted();

    for (const thread of threads) {
      const rows = await get(
        readCurrentChatEventHistory(runtime, thread.id, signal),
      );
      signal.throwIfAborted();

      const messages: ExportTextMessage[] = rows.flatMap((message) => {
        const userMessage = canonicalArchivedChatEventUserMessage(message);
        const content = canonicalArchivedChatEventContent(message);
        if (
          !(
            (isChatEventUserMessageTextType(message.eventType) &&
              userMessage !== null) ||
            (isChatEventContentTextType(message.eventType) && content !== null)
          )
        ) {
          return [];
        }
        const role = chatEventCompatibilityRole(message.eventType);
        const requiredUserMessage =
          requiredUserMessageForEvent(message.eventType, userMessage) ??
          undefined;
        const projectedContent = requiredUserMessage
          ? projectUserMessage(requiredUserMessage).displayText
          : content;
        if (!projectedContent) {
          return [];
        }
        return [
          {
            role,
            content: projectedContent,
            ...(requiredUserMessage
              ? { userMessage: requiredUserMessage }
              : {}),
            createdAt: message.createdAt,
          },
        ];
      });

      if (messages.length > 0) {
        entries.push({
          path: `conversations/chat-thread-${thread.id}.json`,
          content: JSON.stringify(messages, null, 2),
        });
        threadCount += 1;
      }
    }

    const sessionsWithHistory = await runtime.db
      .select({
        id: agentSessions.id,
        cliAgentType: conversations.cliAgentType,
        cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
        sessionHistoryBlobEncoding: blobs.encoding,
        sessionHistoryBlobEncodedSize: blobs.encodedSize,
        sessionHistoryBlobRawSize: blobs.rawSize,
      })
      .from(agentSessions)
      .innerJoin(
        conversations,
        eq(conversations.id, agentSessions.conversationId),
      )
      .leftJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
      .where(
        and(
          eq(agentSessions.userId, userId),
          or(
            isNotNull(conversations.cliAgentSessionHistory),
            isNotNull(conversations.cliAgentSessionHistoryHash),
          ),
        ),
      )
      .orderBy(asc(agentSessions.createdAt), asc(agentSessions.id));
    signal.throwIfAborted();

    for (const session of sessionsWithHistory) {
      const history = await get(
        resolveSessionHistory(
          runtime,
          {
            sessionId: session.id,
            hash: session.cliAgentSessionHistoryHash,
            encoding: session.sessionHistoryBlobEncoding,
            rawSize: session.sessionHistoryBlobRawSize,
            encodedSize: session.sessionHistoryBlobEncodedSize,
          },
          signal,
        ),
      );

      const exportedHistory =
        session.cliAgentType === "pi"
          ? Buffer.from(
              projectPiSessionJsonlForExport(history.toString("utf8")),
              "utf8",
            )
          : history;
      entries.push({
        path: `conversations/${session.id}-history.jsonl`,
        content: exportedHistory,
      });
      sessionHistoryCount += 1;
    }

    return { entries, threadCount, sessionHistoryCount };
  });
}

function collectUserData(
  runtime: ExportRuntime,
  userId: string,
  orgId: string,
  signal: AbortSignal,
): Computed<Promise<CollectedData>> {
  return computed(async (get) => {
    const agentInstructions = await get(
      collectAgentInstructionFiles(runtime, userId, signal),
    );
    const workflows = await get(collectWorkflowFiles(runtime, userId, signal));
    const memory = await get(collectMemoryFiles(runtime, userId, signal));
    const memoryStage1Candidates = await get(
      collectPiMemoryStage1Candidates(runtime, userId, signal),
    );
    const memoryPhase2Jobs = await get(
      collectPiMemoryPhase2Jobs(runtime, userId, signal),
    );
    const memoryPhase2PublicationProvenance = await get(
      collectPiMemoryPublicationProvenance(runtime, userId, signal),
    );
    const conversationsResult = await get(
      collectConversationMessages(runtime, userId, signal),
    );
    const zipEntries: ZipEntry[] = [
      ...agentInstructions.entries,
      ...workflows.entries,
      ...memory.entries,
      ...memoryStage1Candidates.entries,
      ...memoryPhase2Jobs.entries,
      ...memoryPhase2PublicationProvenance.entries,
      ...conversationsResult.entries,
    ];

    zipEntries.push({
      path: "export-manifest.json",
      content: JSON.stringify(
        {
          exportedAt: nowDate().toISOString(),
          userId,
          requestOrgId: orgId,
          counts: {
            agentInstructionFiles: agentInstructions.count,
            workflowFiles: workflows.count,
            memoryFiles: memory.count,
            memoryStage1Candidates: memoryStage1Candidates.count,
            memoryPhase2Jobs: memoryPhase2Jobs.count,
            memoryPhase2PublicationProvenance:
              memoryPhase2PublicationProvenance.count,
            conversationThreads: conversationsResult.threadCount,
            sessionHistories: conversationsResult.sessionHistoryCount,
          },
        },
        null,
        2,
      ),
    });

    return { zipEntries };
  });
}

async function assembleZip(
  entries: readonly ZipEntry[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = createDeferredPromise<Buffer>(signal);

  archive.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  archive.on("end", () => {
    if (!done.settled()) {
      done.resolve(Buffer.concat(chunks));
    }
  });
  archive.on("error", (error) => {
    if (!done.settled()) {
      done.reject(error);
    }
  });

  const appendResult = safeSync(() => {
    for (const entry of entries) {
      archive.append(
        typeof entry.content === "string"
          ? Buffer.from(entry.content)
          : entry.content,
        { name: entry.path },
      );
    }
  });
  if ("error" in appendResult) {
    if (!done.settled()) {
      done.reject(appendResult.error);
    }
    return await done.promise;
  }

  const finalized = (async () => {
    await onRejection(archive.finalize(), (error) => {
      if (!done.settled()) {
        done.reject(error);
      }
    });
    signal.throwIfAborted();
    return await done.promise;
  })();
  return await Promise.race([done.promise, finalized]);
}

async function isUserUnsubscribed(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.emailUnsubscribed ?? false;
}

function getCachedUserEmail(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const [cached] = await runtime.db
      .select({ email: userCache.email, cachedAt: userCache.cachedAt })
      .from(userCache)
      .where(eq(userCache.userId, userId))
      .limit(1);
    signal.throwIfAborted();

    if (
      cached &&
      nowDate().getTime() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS
    ) {
      return cached.email;
    }

    const client = get(clerk$);
    const user = await findClerkUser(client, userId, signal);
    signal.throwIfAborted();
    if (!user) {
      throw new Error(`No Clerk user found for user ${userId}`);
    }

    const email = primaryEmail(user);
    if (!email) {
      throw new Error(`No primary email found for user ${userId}`);
    }

    await runtime.db
      .insert(userCache)
      .values({
        userId,
        email,
        name: displayName(user),
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: {
          email,
          name: displayName(user),
          imageUrl: user.imageUrl ?? null,
          cachedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    return email;
  });
}

function enqueueExportReadyEmail(
  runtime: ExportRuntime,
  args: {
    readonly userId: string;
    readonly downloadUrl: string;
    readonly expiresAt: Date;
    readonly artifactCount: number;
  },
  signal: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get) => {
    if (await isUserUnsubscribed(runtime.db, args.userId)) {
      log.debug("export email skipped because user is unsubscribed", {
        userId: args.userId,
      });
      return;
    }
    signal.throwIfAborted();

    const email = await get(getCachedUserEmail(runtime, args.userId, signal));
    const unsubscribeUrl = buildUnsubscribeUrl(args.userId);
    const oneClickUnsubscribeUrl = buildOneClickUnsubscribeUrl(args.userId);
    const formattedExpiry = args.expiresAt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    await runtime.db.insert(emailOutbox).values({
      fromAddress: buildFromAddress(),
      toAddresses: email,
      subject: DATA_EXPORT_READY_SUBJECT,
      publicBrand: EMAIL_PUBLIC_BRAND,
      headers: buildUnsubscribeHeaders(oneClickUnsubscribeUrl),
      template: {
        template: "data-export-ready",
        props: {
          downloadUrl: args.downloadUrl,
          expiresAt: formattedExpiry,
          artifactCount: args.artifactCount,
          unsubscribeUrl,
        },
      },
      status: "pending",
      attempts: 0,
    });
    signal.throwIfAborted();
  });
}

function exportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return { jobId: result.jobId, status: result.status };
}

export function toUserExportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return exportStartResponse(result);
}

const runExportJob$ = command(async function runExportJob(
  { get },
  runtime: ExportRuntime,
  args: ExecuteUserExportJobArgs,
  signal: AbortSignal,
): Promise<void> {
  await runtime.db
    .update(exportJobs)
    .set({ status: "running" })
    .where(
      and(eq(exportJobs.id, args.jobId), eq(exportJobs.status, "pending")),
    );
  signal.throwIfAborted();

  const expiresAt = new Date(nowDate().getTime() + EXPORT_DOWNLOAD_EXPIRY_MS);
  const { zipEntries } = await get(
    collectUserData(runtime, args.userId, args.orgId, signal),
  );
  signal.throwIfAborted();

  const zipBuffer = await assembleZip(zipEntries, signal);
  signal.throwIfAborted();

  const s3Key = `exports/${args.userId}/${args.jobId}.zip`;
  await get(putS3Object(runtime.bucket, s3Key, zipBuffer, "application/zip"));
  signal.throwIfAborted();

  const downloadUrl = await get(
    generatePresignedGetUrl(runtime.bucket, s3Key, DATA_EXPORT_FILENAME, true),
  );
  signal.throwIfAborted();

  await runtime.db
    .update(exportJobs)
    .set({
      status: "completed",
      s3Key,
      artifactUrls: null,
      completedAt: nowDate(),
      expiresAt,
    })
    .where(eq(exportJobs.id, args.jobId));
  signal.throwIfAborted();

  await get(
    enqueueExportReadyEmail(
      runtime,
      {
        userId: args.userId,
        downloadUrl,
        expiresAt,
        artifactCount: 0,
      },
      signal,
    ),
  );
  signal.throwIfAborted();

  log.debug("export job completed", { jobId: args.jobId });
});

export const executeUserExportJob$ = command(
  async (
    { set },
    args: ExecuteUserExportJobArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const runtime: ExportRuntime = {
      db,
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    };

    await tapError(set(runExportJob$, runtime, args, signal), async (error) => {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error("export job failed", { jobId: args.jobId, error });

      await db
        .update(exportJobs)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: nowDate(),
        })
        .where(
          and(
            eq(exportJobs.id, args.jobId),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        );
    });
    signal.throwIfAborted();
  },
);
