import { MAX_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/storages";
import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command, computed, type Computed } from "ccstate";
import { and, eq, gt } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  downloadManifest,
  generatePresignedPutUrl,
  s3ObjectExists,
  s3ObjectHead,
  type S3ObjectHead,
  verifyS3FilesExist,
} from "../external/s3";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "./storage-content-hash.service";
import { enqueueMemorySummaryProjection } from "./memory-summary-projection.service";
import { notifyPiMemoryPhase2ExternalHeadChange } from "./pi-memory-phase2-job.service";
import {
  piMemoryPhase2MaintenanceCallbackPayloadSchema,
  settlePiMemoryPhase2Checkpoint,
} from "./pi-memory-phase2-maintenance.service";
import {
  findPiMemoryPhase2Checkpoint,
  recordPiMemoryPhase2Checkpoint,
} from "./pi-memory-phase2-checkpoint.service";

import { enqueuePiResourceVersionIndexes } from "./pi-resource-version-index.service";

const ACTIVE_SANDBOX_STORAGE_RUN_STATUSES = ["pending", "running"] as const;

interface StorageChanges {
  readonly deleted?: readonly string[];
}

interface PiMemoryPhase2CheckpointAttestation {
  readonly schemaVersion: number;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
  readonly validatedVersionId: string;
}

interface PrepareStorageUploadInput {
  readonly files: readonly FileEntryWithHash[];
  readonly force?: boolean;
  readonly runId?: string;
  readonly parentVersionId?: string;
  readonly baseVersion?: string;
  readonly changes?: StorageChanges;
  readonly maintenanceAttestation?: PiMemoryPhase2CheckpointAttestation;
}

interface PrepareStorageInput extends PrepareStorageUploadInput {
  readonly auth: SandboxAuth;
  readonly storageId: string;
}

interface PrepareStorageForStorageInput extends PrepareStorageUploadInput {
  readonly storageId: string;
}

interface CommitStorageUploadInput {
  readonly versionId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly runId?: string;
  readonly parentVersionId?: string;
  readonly message?: string;
  readonly maintenanceAttestation?: PiMemoryPhase2CheckpointAttestation;
}

interface CommitStorageInput extends CommitStorageUploadInput {
  readonly auth: SandboxAuth;
  readonly storageId: string;
}

interface CommitStorageForStorageInput extends CommitStorageUploadInput {
  readonly storageId: string;
  readonly sandboxAuth?: SandboxAuth;
}

type StorageRow = typeof storages.$inferSelect;
type StorageVersionRow = typeof storageVersions.$inferSelect;

interface MountedWritebackStorage {
  readonly runStatus: typeof agentRuns.$inferSelect.status;
  readonly storage: StorageRow;
}

function storageRowSelection() {
  return {
    id: storages.id,
    userId: storages.userId,
    name: storages.name,
    orgId: storages.orgId,
    s3Prefix: storages.s3Prefix,
    size: storages.size,
    fileCount: storages.fileCount,
    headVersionId: storages.headVersionId,
    createdAt: storages.createdAt,
    updatedAt: storages.updatedAt,
  };
}

type StorageErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly status: 413;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "PAYLOAD_TOO_LARGE";
        };
      };
    }
  | {
      readonly status: 500;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "INTERNAL_ERROR";
        };
      };
    };

type PrepareStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly versionId: string;
        readonly existing: boolean;
        readonly uploads?: {
          readonly archive: {
            readonly key: string;
            readonly presignedUrl: string;
          };
          readonly manifest: {
            readonly key: string;
            readonly presignedUrl: string;
          };
        };
      };
    }
  | StorageErrorResponse;

type CommitStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly success: true;
        readonly versionId: string;
        readonly storageName: string;
        readonly size: number;
        readonly fileCount: number;
        readonly deduplicated?: boolean;
      };
    }
  | StorageErrorResponse
  | {
      readonly status: 409;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "S3_FILES_MISSING";
        };
      };
    };

function payloadTooLarge(message: string): StorageErrorResponse {
  return {
    status: 413,
    body: { error: { message, code: "PAYLOAD_TOO_LARGE" } },
  };
}

function internalError(message: string): StorageErrorResponse {
  return {
    status: 500,
    body: { error: { message, code: "INTERNAL_ERROR" } },
  };
}

function storageServiceNotConfigured(): StorageErrorResponse {
  return internalError("Storage service is not properly configured");
}

async function findMountedWritebackStorage(
  args: {
    readonly db: Db;
    readonly auth: SandboxAuth;
    readonly storageId: string;
  },
  signal: AbortSignal,
): Promise<MountedWritebackStorage | StorageErrorResponse> {
  const [run] = await args.db
    .select({
      status: agentRuns.status,
      storageMounts: agentRuns.storageMounts,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.auth.runId),
        eq(agentRuns.userId, args.auth.userId),
        eq(agentRuns.orgId, args.auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === args.storageId && entry.writeback === true;
  });
  if (!mount) {
    return notFound("Writeback storage not found");
  }

  const [storage] = await args.db
    .select(storageRowSelection())
    .from(storages)
    .where(
      and(
        eq(storages.id, mount.storageId),
        eq(storages.orgId, mount.orgId),
        eq(storages.userId, mount.userId),
        eq(storages.name, mount.name),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  return storage
    ? { runStatus: run.status, storage }
    : notFound("Writeback storage not found");
}

async function lockMountedWritebackStorage(
  args: {
    readonly tx: Tx;
    readonly auth: SandboxAuth;
    readonly storageId: string;
  },
  signal: AbortSignal,
): Promise<MountedWritebackStorage | StorageErrorResponse> {
  const [run] = await args.tx
    .select({
      status: agentRuns.status,
      storageMounts: agentRuns.storageMounts,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.auth.runId),
        eq(agentRuns.userId, args.auth.userId),
        eq(agentRuns.orgId, args.auth.orgId),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === args.storageId && entry.writeback === true;
  });
  if (!mount) {
    return notFound("Writeback storage not found");
  }

  const [storage] = await args.tx
    .select(storageRowSelection())
    .from(storages)
    .where(
      and(
        eq(storages.id, mount.storageId),
        eq(storages.orgId, mount.orgId),
        eq(storages.userId, mount.userId),
        eq(storages.name, mount.name),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  return storage
    ? { runStatus: run.status, storage }
    : notFound("Writeback storage not found");
}

function sandboxStorageRunIsActive(
  status: typeof agentRuns.$inferSelect.status,
): boolean {
  return ACTIVE_SANDBOX_STORAGE_RUN_STATUSES.some((activeStatus) => {
    return status === activeStatus;
  });
}

async function guardPiMemoryPhase2MaintenancePublication(args: {
  readonly db: Db | Tx;
  readonly auth: SandboxAuth;
  readonly storageId: string;
  readonly parentVersionId: string | undefined;
  readonly versionId: string;
  readonly attestation: PiMemoryPhase2CheckpointAttestation | undefined;
  readonly allowCommittedReplay: boolean;
}): Promise<StorageErrorResponse | undefined> {
  const [callback] = await args.db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.auth.runId),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .limit(1);
  if (!callback) {
    return args.attestation
      ? badRequestMessage("Unexpected maintenance checkpoint attestation")
      : undefined;
  }

  const payload = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    callback.payload,
  );
  const attestation = args.attestation;
  if (
    !payload.success ||
    !attestation ||
    !matchesMaintenancePublication(payload.data, attestation, args)
  ) {
    return notFound("Active Pi memory maintenance publication not found");
  }

  const receipt = await findPiMemoryPhase2Checkpoint(args.db, {
    ...payload.data,
    runId: args.auth.runId,
  });
  if (receipt) {
    return args.allowCommittedReplay && receipt.versionId === args.versionId
      ? undefined
      : notFound("Pi memory maintenance checkpoint already committed");
  }

  const [active] = await args.db
    .select({ id: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, args.storageId),
        eq(piMemoryPhase2Jobs.orgId, args.auth.orgId),
        eq(piMemoryPhase2Jobs.userId, args.auth.userId),
        eq(piMemoryPhase2Jobs.status, "leased"),
        eq(piMemoryPhase2Jobs.leaseToken, attestation.leaseToken),
        eq(piMemoryPhase2Jobs.sandboxLeaseToken, attestation.leaseToken),
        eq(piMemoryPhase2Jobs.claimedRevision, attestation.claimedRevision),
        eq(
          piMemoryPhase2Jobs.claimedBaseVersionId,
          attestation.claimedBaseVersionId,
        ),
        eq(
          piMemoryPhase2Jobs.claimedSelectionDigest,
          attestation.selectionDigest,
        ),
        eq(piMemoryPhase2Jobs.maintenanceRunId, args.auth.runId),
        gt(piMemoryPhase2Jobs.leaseExpiresAt, nowDate()),
      ),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  if (active) {
    return undefined;
  }
  // A concurrent commit can settle the claim while this request waits for its
  // row lock. Read the immutable receipt again in the next statement snapshot.
  if (args.allowCommittedReplay) {
    const committed = await findPiMemoryPhase2Checkpoint(args.db, {
      ...payload.data,
      runId: args.auth.runId,
    });
    if (committed?.versionId === args.versionId) {
      return undefined;
    }
  }
  return notFound("Active Pi memory maintenance publication not found");
}

function matchesMaintenancePublication(
  payload: ReturnType<
    typeof piMemoryPhase2MaintenanceCallbackPayloadSchema.parse
  >,
  attestation: PiMemoryPhase2CheckpointAttestation,
  args: Parameters<typeof guardPiMemoryPhase2MaintenancePublication>[0],
): boolean {
  return (
    payload.memoryStorageId === args.storageId &&
    payload.orgId === args.auth.orgId &&
    payload.userId === args.auth.userId &&
    payload.leaseToken === attestation.leaseToken &&
    payload.claimedRevision === attestation.claimedRevision &&
    payload.claimedBaseVersionId === attestation.claimedBaseVersionId &&
    payload.selectionDigest === attestation.selectionDigest &&
    args.parentVersionId === attestation.claimedBaseVersionId &&
    args.versionId === attestation.validatedVersionId
  );
}

function maintenanceCheckpointBinding(input: CommitStorageForStorageInput) {
  const auth = input.sandboxAuth;
  const attestation = input.maintenanceAttestation;
  if (
    !auth ||
    !attestation ||
    input.parentVersionId !== attestation.claimedBaseVersionId ||
    input.versionId !== attestation.validatedVersionId
  ) {
    return undefined;
  }
  return {
    runId: auth.runId,
    memoryStorageId: input.storageId,
    orgId: auth.orgId,
    userId: auth.userId,
    leaseToken: attestation.leaseToken,
    claimedRevision: attestation.claimedRevision,
    claimedBaseVersionId: attestation.claimedBaseVersionId,
    selectionDigest: attestation.selectionDigest,
  };
}

function mergeWithBaseVersion(
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly storageId: string;
    readonly files: readonly FileEntryWithHash[];
    readonly baseVersion: string;
    readonly changes: StorageChanges;
  },
  signal: AbortSignal,
): Computed<Promise<readonly FileEntryWithHash[]>> {
  return computed(async (get): Promise<readonly FileEntryWithHash[]> => {
    const [baseVersionRecord] = await args.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, args.baseVersion),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!baseVersionRecord) {
      return args.files;
    }

    if (baseVersionRecord.fileCount === 0) {
      return args.files;
    }

    const baseManifest = await get(
      downloadManifest(args.bucket, baseVersionRecord.s3Key),
    );
    signal.throwIfAborted();

    const currentFiles = new Map(
      args.files.map((file) => {
        return [file.path, file];
      }),
    );
    const deleted = new Set(args.changes.deleted ?? []);
    const baseFiles = baseManifest.files.filter((file) => {
      return !deleted.has(file.path) && !currentFiles.has(file.path);
    });

    return [...baseFiles, ...args.files];
  });
}

function totalSize(files: readonly FileEntryWithHash[]): number {
  return files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
}

async function findStorageVersion(args: {
  readonly db: Db;
  readonly storageId: string;
  readonly versionId: string;
}): Promise<StorageVersionRow | undefined> {
  const [version] = await args.db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, args.storageId),
        eq(storageVersions.id, args.versionId),
      ),
    )
    .limit(1);

  return version;
}

async function findStorageById(args: {
  readonly db: Db;
  readonly storageId: string;
}): Promise<StorageRow | undefined> {
  const [storage] = await args.db
    .select(storageRowSelection())
    .from(storages)
    .where(eq(storages.id, args.storageId))
    .limit(1);

  return storage;
}

async function resolveStorageForPrepare(
  args: {
    readonly db: Db;
    readonly input: PrepareStorageInput;
  },
  signal: AbortSignal,
): Promise<MountedWritebackStorage | StorageErrorResponse> {
  return await findMountedWritebackStorage(
    {
      db: args.db,
      auth: args.input.auth,
      storageId: args.input.storageId,
    },
    signal,
  );
}

function resolvePreparedFiles(
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly storageId: string;
    readonly input: PrepareStorageUploadInput;
  },
  signal: AbortSignal,
): Computed<Promise<readonly FileEntryWithHash[]>> {
  return computed(async (get): Promise<readonly FileEntryWithHash[]> => {
    const baseVersion = args.input.baseVersion;
    const changes = args.input.changes;
    if (!baseVersion || !changes) {
      return args.input.files;
    }

    const files = await get(
      mergeWithBaseVersion(
        {
          db: args.db,
          bucket: args.bucket,
          storageId: args.storageId,
          files: args.input.files,
          baseVersion,
          changes,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    return files;
  });
}

function existingStorageVersionIsReusable(
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly storageId: string;
    readonly allowMissingObjectsForEmptyVersion: boolean;
    readonly versionId: string;
    readonly force: boolean | undefined;
  },
  signal: AbortSignal,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    if (args.force) {
      return false;
    }

    const existingVersion = await findStorageVersion({
      db: args.db,
      storageId: args.storageId,
      versionId: args.versionId,
    });
    signal.throwIfAborted();

    if (!existingVersion) {
      return false;
    }

    const exists = await get(
      verifyS3FilesExist(
        args.bucket,
        existingVersion.s3Key,
        existingVersion.fileCount,
        {
          allowMissingObjectsForEmptyVersion:
            args.allowMissingObjectsForEmptyVersion,
        },
      ),
    );
    signal.throwIfAborted();

    return exists;
  });
}

function createStorageUploadResponse(
  args: {
    readonly bucket: string;
    readonly storage: StorageRow;
    readonly versionId: string;
  },
  signal: AbortSignal,
): Computed<Promise<PrepareStorageResponse>> {
  return computed(async (get): Promise<PrepareStorageResponse> => {
    const s3Key = `${args.storage.s3Prefix}/${args.versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;
    const [archiveUrl, manifestUrl] = await Promise.all([
      get(
        generatePresignedPutUrl(
          args.bucket,
          archiveKey,
          "application/gzip",
          { expiresIn: 3600, usePublicEndpoint: true },
          signal,
        ),
      ),
      get(
        generatePresignedPutUrl(
          args.bucket,
          manifestKey,
          "application/json",
          { expiresIn: 3600, usePublicEndpoint: true },
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();

    return {
      status: 200,
      body: {
        versionId: args.versionId,
        existing: false,
        uploads: {
          archive: { key: archiveKey, presignedUrl: archiveUrl },
          manifest: { key: manifestKey, presignedUrl: manifestUrl },
        },
      },
    };
  });
}

function s3FilesMissingConflict(): Extract<
  CommitStorageResponse,
  { status: 409 }
> {
  return {
    status: 409,
    body: {
      error: {
        message: "S3 files missing for existing version - please retry upload",
        code: "S3_FILES_MISSING",
      },
    },
  };
}

type ArchiveVerification =
  | { readonly kind: "verified"; readonly archiveSize: number }
  | { readonly kind: "missing-archive" }
  | { readonly kind: "invalid-archive-size" };

type UploadedStorageFilesVerification =
  | ArchiveVerification
  | { readonly kind: "missing-manifest" };

function verifyArchiveHead(
  archiveHead: S3ObjectHead,
  fileCount: number,
): ArchiveVerification {
  if (archiveHead.kind === "missing") {
    return fileCount === 0
      ? { kind: "verified", archiveSize: 0 }
      : { kind: "missing-archive" };
  }

  const archiveSize = archiveHead.contentLength;
  if (
    archiveSize === undefined ||
    !Number.isSafeInteger(archiveSize) ||
    archiveSize <= 0
  ) {
    return { kind: "invalid-archive-size" };
  }
  return { kind: "verified", archiveSize };
}

function verifyUploadedStorageFiles(
  args: {
    readonly bucket: string;
    readonly s3Key: string;
    readonly fileCount: number;
  },
  signal: AbortSignal,
): Computed<Promise<UploadedStorageFilesVerification>> {
  return computed(async (get): Promise<UploadedStorageFilesVerification> => {
    const manifestKey = `${args.s3Key}/manifest.json`;
    const archiveKey = `${args.s3Key}/archive.tar.gz`;
    const [manifestExists, archiveHead] = await Promise.all([
      get(s3ObjectExists(args.bucket, manifestKey)),
      get(s3ObjectHead(args.bucket, archiveKey)),
    ]);
    signal.throwIfAborted();

    if (!manifestExists) {
      return { kind: "missing-manifest" };
    }
    return verifyArchiveHead(archiveHead, args.fileCount);
  });
}

interface VerifiedStorageCommit {
  readonly archiveSize: number;
  readonly s3Key: string;
}

function terminalStorageCommitPersistedStateMatches(args: {
  readonly storage: StorageRow;
  readonly version: StorageVersionRow | undefined;
  readonly input: CommitStorageForStorageInput;
}): boolean {
  const version = args.version;
  const sandboxAuth = args.input.sandboxAuth;
  const parentVersionId = args.input.parentVersionId;
  const size = totalSize(args.input.files);
  const fileCount = args.input.files.length;
  return (
    version !== undefined &&
    sandboxAuth !== undefined &&
    parentVersionId !== undefined &&
    version.s3Key === `${args.storage.s3Prefix}/${args.input.versionId}` &&
    Number(version.size) === size &&
    version.fileCount === fileCount &&
    version.message === (args.input.message ?? null) &&
    version.createdBy === "agent" &&
    args.storage.headVersionId === args.input.versionId &&
    Number(args.storage.size) === size &&
    args.storage.fileCount === fileCount
  );
}

function verifyStorageCommit(
  args: {
    readonly bucket: string;
    readonly storage: StorageRow;
    readonly version: StorageVersionRow | undefined;
    readonly input: CommitStorageUploadInput;
  },
  signal: AbortSignal,
): Computed<Promise<VerifiedStorageCommit | CommitStorageResponse>> {
  return computed(
    async (get): Promise<VerifiedStorageCommit | CommitStorageResponse> => {
      if (args.version?.fileCount === 0) {
        return {
          archiveSize: args.version.archiveSize,
          s3Key: args.version.s3Key,
        };
      }

      const s3Key =
        args.version?.s3Key ??
        `${args.storage.s3Prefix}/${args.input.versionId}`;
      const verification = await get(
        verifyUploadedStorageFiles(
          {
            bucket: args.bucket,
            s3Key,
            fileCount: args.version?.fileCount ?? args.input.files.length,
          },
          signal,
        ),
      );
      signal.throwIfAborted();

      if (args.version) {
        return verification.kind === "verified"
          ? {
              archiveSize: verification.archiveSize,
              s3Key,
            }
          : s3FilesMissingConflict();
      }

      switch (verification.kind) {
        case "verified": {
          return {
            archiveSize: verification.archiveSize,
            s3Key,
          };
        }
        case "missing-manifest": {
          return badRequestMessage(
            "Manifest not uploaded - upload failed or incomplete",
          );
        }
        case "missing-archive": {
          return badRequestMessage(
            "Archive not uploaded - upload failed or incomplete",
          );
        }
        case "invalid-archive-size": {
          return badRequestMessage(
            "Archive has invalid or missing content length",
          );
        }
      }
    },
  );
}

async function terminalStorageCommitAlreadySucceeded(args: {
  readonly tx: Tx;
  readonly storage: StorageRow;
  readonly version: StorageVersionRow | undefined;
  readonly verification: VerifiedStorageCommit;
  readonly input: CommitStorageForStorageInput;
}): Promise<boolean> {
  const version = args.version;
  const sandboxAuth = args.input.sandboxAuth;
  const parentVersionId = args.input.parentVersionId;
  if (
    !version ||
    !sandboxAuth ||
    !parentVersionId ||
    !terminalStorageCommitPersistedStateMatches({
      storage: args.storage,
      version,
      input: args.input,
    }) ||
    version.s3Key !== args.verification.s3Key ||
    version.archiveSize !== args.verification.archiveSize
  ) {
    return false;
  }

  const [lineage] = await args.tx
    .select({ id: storageVersionLineage.id })
    .from(storageVersionLineage)
    .where(
      and(
        eq(storageVersionLineage.storageId, args.storage.id),
        eq(storageVersionLineage.versionId, args.input.versionId),
        eq(storageVersionLineage.parentVersionId, parentVersionId),
        eq(storageVersionLineage.runId, sandboxAuth.runId),
      ),
    )
    .limit(1);
  return lineage !== undefined;
}

function storageCommitSuccess(args: {
  readonly storage: StorageRow;
  readonly versionId: string;
  readonly size: number;
  readonly fileCount: number;
  readonly deduplicated: boolean;
}): CommitStorageResponse {
  return {
    status: 200,
    body: {
      success: true,
      versionId: args.versionId,
      storageName: args.storage.name,
      size: args.size,
      fileCount: args.fileCount,
      ...(args.deduplicated ? { deduplicated: true } : {}),
    },
  };
}

async function recordStorageLineage(args: {
  readonly tx: Tx;
  readonly storageId: string;
  readonly input: CommitStorageForStorageInput;
}): Promise<void> {
  const sandboxAuth = args.input.sandboxAuth;
  const parentVersionId = args.input.parentVersionId;
  if (!sandboxAuth || !parentVersionId) {
    return;
  }

  await args.tx.insert(storageVersionLineage).values({
    storageId: args.storageId,
    versionId: args.input.versionId,
    parentVersionId,
    runId: sandboxAuth.runId,
  });
}

async function publishStorageHeadIfChanged(args: {
  readonly tx: Tx;
  readonly storage: StorageRow;
  readonly input: Pick<
    CommitStorageForStorageInput,
    "versionId" | "sandboxAuth"
  >;
  readonly size: number;
  readonly fileCount: number;
}): Promise<void> {
  if (args.storage.headVersionId === args.input.versionId) {
    return;
  }
  const changedAt = nowDate();
  const [published] = await args.tx
    .update(storages)
    .set({
      headVersionId: args.input.versionId,
      size: args.size,
      fileCount: args.fileCount,
      updatedAt: changedAt,
    })
    .where(
      and(
        eq(storages.id, args.storage.id),
        eq(storages.orgId, args.storage.orgId),
        eq(storages.userId, args.storage.userId),
        eq(storages.name, args.storage.name),
      ),
    )
    .returning({ id: storages.id });
  if (!published) {
    throw new Error("Locked Storage HEAD could not be published");
  }
  if (
    args.storage.name !== MEMORY_ARTIFACT_NAME ||
    args.storage.userId === VOLUME_ORG_USER_ID
  ) {
    return;
  }
  await notifyPiMemoryPhase2ExternalHeadChange(args.tx, {
    memoryStorageId: args.storage.id,
    orgId: args.storage.orgId,
    userId: args.storage.userId,
    observedHeadVersionId: args.input.versionId,
    changedAt,
    sourceRunId: args.input.sandboxAuth?.runId,
  });
}

async function commitActiveStorageVersion(
  args: {
    readonly tx: Tx;
    readonly storage: StorageRow;
    readonly version: StorageVersionRow | undefined;
    readonly input: CommitStorageForStorageInput;
    readonly verification: VerifiedStorageCommit;
  },
  signal: AbortSignal,
): Promise<CommitStorageResponse> {
  const [storage] = await args.tx
    .select(storageRowSelection())
    .from(storages)
    .where(
      and(
        eq(storages.id, args.storage.id),
        eq(storages.orgId, args.storage.orgId),
        eq(storages.userId, args.storage.userId),
        eq(storages.name, args.storage.name),
      ),
    )
    .limit(1)
    .for("update", { of: storages });
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Storage disappeared before HEAD publication");
  }

  if (args.version) {
    if (args.version.archiveSize !== args.verification.archiveSize) {
      await args.tx
        .update(storageVersions)
        .set({ archiveSize: args.verification.archiveSize })
        .where(
          and(
            eq(storageVersions.id, args.version.id),
            eq(storageVersions.storageId, storage.id),
          ),
        );
    }
    await publishStorageHeadIfChanged({
      tx: args.tx,
      storage,
      input: args.input,
      size: Number(args.version.size),
      fileCount: args.version.fileCount,
    });
    await recordStorageLineage({
      tx: args.tx,
      storageId: storage.id,
      input: args.input,
    });
    await enqueueMemorySummaryProjection(
      {
        db: args.tx,
        storage,
        storageVersionId: args.input.versionId,
      },
      signal,
    );
    return storageCommitSuccess({
      storage,
      versionId: args.input.versionId,
      size: Number(args.version.size),
      fileCount: args.version.fileCount,
      deduplicated: true,
    });
  }

  const size = totalSize(args.input.files);
  const fileCount = args.input.files.length;
  const [insertedVersion] = await args.tx
    .insert(storageVersions)
    .values({
      id: args.input.versionId,
      storageId: storage.id,
      s3Key: args.verification.s3Key,
      size,
      archiveSize: args.verification.archiveSize,
      fileCount,
      message: args.input.message ?? null,
      createdBy: args.input.runId ? "agent" : "user",
    })
    .onConflictDoNothing()
    .returning({ id: storageVersions.id });

  let committedVersion = insertedVersion;
  if (!committedVersion) {
    const [updatedVersion] = await args.tx
      .update(storageVersions)
      .set({ archiveSize: args.verification.archiveSize })
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, args.input.versionId),
        ),
      )
      .returning({ id: storageVersions.id });
    committedVersion = updatedVersion;
  }
  if (!committedVersion) {
    throw new Error(`Version ${args.input.versionId} not found after insert`);
  }

  await publishStorageHeadIfChanged({
    tx: args.tx,
    storage,
    input: args.input,
    size,
    fileCount,
  });
  await recordStorageLineage({
    tx: args.tx,
    storageId: storage.id,
    input: args.input,
  });
  await enqueueMemorySummaryProjection(
    {
      db: args.tx,
      storage,
      storageVersionId: args.input.versionId,
    },
    signal,
  );

  return storageCommitSuccess({
    storage,
    versionId: args.input.versionId,
    size,
    fileCount,
    deduplicated: false,
  });
}

async function committedMaintenanceResponse(
  tx: Tx,
  binding: ReturnType<typeof maintenanceCheckpointBinding>,
  storage: StorageRow,
  version: StorageVersionRow | undefined,
): Promise<CommitStorageResponse | undefined> {
  if (!binding || !version) {
    return undefined;
  }
  const receipt = await findPiMemoryPhase2Checkpoint(tx, binding);
  if (receipt?.versionId !== version.id) {
    return undefined;
  }
  return storageCommitSuccess({
    storage,
    versionId: version.id,
    size: Number(version.size),
    fileCount: version.fileCount,
    deduplicated: true,
  });
}

async function recordAndSettleMaintenanceCheckpoint(
  tx: Tx,
  binding: NonNullable<ReturnType<typeof maintenanceCheckpointBinding>>,
  versionId: string,
): Promise<void> {
  await recordPiMemoryPhase2Checkpoint(tx, { ...binding, versionId });
  await settlePiMemoryPhase2Checkpoint(tx, binding.runId, versionId);
}

async function commitStorageVersionInTransaction(
  tx: Tx,
  args: {
    readonly input: CommitStorageForStorageInput;
    readonly verification: VerifiedStorageCommit;
  },
  signal: AbortSignal,
): Promise<CommitStorageResponse> {
  const mounted = args.input.sandboxAuth
    ? await lockMountedWritebackStorage(
        {
          tx,
          auth: args.input.sandboxAuth,
          storageId: args.input.storageId,
        },
        signal,
      )
    : undefined;
  if (mounted && "status" in mounted) {
    return mounted;
  }

  const [userStorage] = mounted
    ? []
    : await tx
        .select(storageRowSelection())
        .from(storages)
        .where(eq(storages.id, args.input.storageId))
        .limit(1);
  signal.throwIfAborted();
  const storage = mounted?.storage ?? userStorage;
  if (!storage) {
    return notFound("Storage not found");
  }

  if (args.input.sandboxAuth) {
    const maintenanceGuard = await guardPiMemoryPhase2MaintenancePublication({
      db: tx,
      auth: args.input.sandboxAuth,
      storageId: storage.id,
      parentVersionId: args.input.parentVersionId,
      versionId: args.input.versionId,
      attestation: args.input.maintenanceAttestation,
      allowCommittedReplay: true,
    });
    signal.throwIfAborted();
    if (maintenanceGuard) {
      return maintenanceGuard;
    }
  }

  const [version] = await tx
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, args.input.versionId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  const binding = maintenanceCheckpointBinding(args.input);
  const replay = await committedMaintenanceResponse(
    tx,
    binding,
    storage,
    version,
  );
  if (replay) {
    return replay;
  }

  if (mounted && !sandboxStorageRunIsActive(mounted.runStatus)) {
    const alreadySucceeded = await terminalStorageCommitAlreadySucceeded({
      tx,
      storage,
      version,
      verification: args.verification,
      input: args.input,
    });
    signal.throwIfAborted();
    return alreadySucceeded && version
      ? storageCommitSuccess({
          storage,
          versionId: args.input.versionId,
          size: Number(version.size),
          fileCount: version.fileCount,
          deduplicated: true,
        })
      : notFound("Active agent run not found");
  }

  // A validated no-diff receipt acknowledges the mounted epoch. It must not
  // restore that epoch as HEAD if another ordinary writer has since published.
  if (
    binding &&
    args.input.versionId === binding.claimedBaseVersionId &&
    version
  ) {
    await recordAndSettleMaintenanceCheckpoint(tx, binding, version.id);
    return storageCommitSuccess({
      storage,
      versionId: version.id,
      size: Number(version.size),
      fileCount: version.fileCount,
      deduplicated: true,
    });
  }
  const response = await commitActiveStorageVersion(
    {
      tx,
      storage,
      version,
      input: args.input,
      verification: args.verification,
    },
    signal,
  );
  if (binding && response.status === 200) {
    await recordAndSettleMaintenanceCheckpoint(
      tx,
      binding,
      args.input.versionId,
    );
  }
  return response;
}

async function commitVerifiedStorageVersion(
  args: {
    readonly db: Db;
    readonly input: CommitStorageForStorageInput;
    readonly verification: VerifiedStorageCommit;
  },
  signal: AbortSignal,
): Promise<CommitStorageResponse> {
  return await args.db.transaction(async (tx) => {
    const response = await commitStorageVersionInTransaction(tx, args, signal);
    signal.throwIfAborted();
    if (response.status === 200) {
      await enqueuePiResourceVersionIndexes(tx, [args.input.versionId], signal);
    }
    return response;
  });
}

export const prepareStorageUploadForStorage$ = command(
  async (
    { get, set },
    args: PrepareStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const declaredSize = totalSize(args.files);
    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      return payloadTooLarge(
        "Upload rejected: total file size exceeds 100MB limit",
      );
    }

    const writeDb = set(writeDb$);
    const storage = await findStorageById({
      db: writeDb,
      storageId: args.storageId,
    });
    signal.throwIfAborted();

    if (!storage) {
      return notFound("Storage not found");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const mergedFiles = await get(
      resolvePreparedFiles(
        {
          db: writeDb,
          bucket,
          storageId: storage.id,
          input: args,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);

    const existingReusable = await get(
      existingStorageVersionIsReusable(
        {
          db: writeDb,
          bucket,
          storageId: storage.id,
          allowMissingObjectsForEmptyVersion: true,
          versionId,
          force: args.force,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (existingReusable) {
      return { status: 200, body: { versionId, existing: true } };
    }

    return await get(
      createStorageUploadResponse(
        {
          bucket,
          storage,
          versionId,
        },
        signal,
      ),
    );
  },
);

export const commitStorageUploadForStorage$ = command(
  async (
    { get, set },
    args: CommitStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const writeDb = set(writeDb$);
    const storage = await findStorageById({
      db: writeDb,
      storageId: args.storageId,
    });
    signal.throwIfAborted();

    if (!storage) {
      return notFound("Storage not found");
    }

    const computedVersionId = computeContentHashFromHashes(
      storage.id,
      args.files,
    );
    if (computedVersionId !== args.versionId) {
      return badRequestMessage("Version ID mismatch - files may have changed");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const existingVersion = await findStorageVersion({
      db: writeDb,
      storageId: storage.id,
      versionId: args.versionId,
    });
    signal.throwIfAborted();

    const verification = await get(
      verifyStorageCommit(
        {
          bucket,
          storage,
          version: existingVersion,
          input: args,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if ("status" in verification) {
      return verification;
    }

    return await commitVerifiedStorageVersion(
      {
        db: writeDb,
        input: args,
        verification,
      },
      signal,
    );
  },
);

export const prepareStorageUploadForAuth$ = command(
  async (
    { set },
    args: PrepareStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const writeDb = set(writeDb$);
    const mounted = await resolveStorageForPrepare(
      {
        db: writeDb,
        input: args,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("status" in mounted) {
      return mounted;
    }
    if (!sandboxStorageRunIsActive(mounted.runStatus)) {
      return notFound("Active agent run not found");
    }

    const maintenanceGuard = await guardPiMemoryPhase2MaintenancePublication({
      db: writeDb,
      auth: args.auth,
      storageId: args.storageId,
      parentVersionId: args.parentVersionId,
      versionId: computeContentHashFromHashes(args.storageId, args.files),
      attestation: args.maintenanceAttestation,
      allowCommittedReplay: false,
    });
    signal.throwIfAborted();
    if (maintenanceGuard) {
      return maintenanceGuard;
    }

    const response = await set(
      prepareStorageUploadForStorage$,
      {
        storageId: args.storageId,
        files: args.files,
        force: args.force,
        runId: args.runId,
        parentVersionId: args.parentVersionId,
        baseVersion: args.baseVersion,
        changes: args.changes,
        maintenanceAttestation: args.maintenanceAttestation,
      },
      signal,
    );
    signal.throwIfAborted();
    if (response.status !== 200) {
      return response;
    }

    const admitted = await writeDb.transaction(async (tx) => {
      const current = await lockMountedWritebackStorage(
        { tx, auth: args.auth, storageId: args.storageId },
        signal,
      );
      return !(
        "status" in current || !sandboxStorageRunIsActive(current.runStatus)
      );
    });
    signal.throwIfAborted();
    return admitted ? response : notFound("Active agent run not found");
  },
);

export const commitStorageUploadForAuth$ = command(
  async (
    { set },
    args: CommitStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const writeDb = set(writeDb$);
    const mounted = await findMountedWritebackStorage(
      {
        db: writeDb,
        auth: args.auth,
        storageId: args.storageId,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("status" in mounted) {
      return mounted;
    }

    const commitInput: CommitStorageForStorageInput = {
      storageId: args.storageId,
      versionId: args.versionId,
      files: args.files,
      runId: args.runId,
      parentVersionId: args.parentVersionId,
      message: args.message,
      maintenanceAttestation: args.maintenanceAttestation,
      sandboxAuth: args.auth,
    };
    const binding = maintenanceCheckpointBinding(commitInput);
    const receipt = binding
      ? await findPiMemoryPhase2Checkpoint(writeDb, binding)
      : undefined;
    signal.throwIfAborted();
    if (receipt) {
      if (
        receipt.versionId !== args.versionId ||
        computeContentHashFromHashes(args.storageId, args.files) !==
          receipt.versionId
      ) {
        return notFound("Pi memory maintenance checkpoint replay mismatch");
      }
      const version = await findStorageVersion({
        db: writeDb,
        storageId: args.storageId,
        versionId: receipt.versionId,
      });
      signal.throwIfAborted();
      if (!version) {
        return notFound("Pi memory maintenance checkpoint version not found");
      }
      return storageCommitSuccess({
        storage: mounted.storage,
        versionId: version.id,
        size: Number(version.size),
        fileCount: version.fileCount,
        deduplicated: true,
      });
    }
    const terminalRetry = !sandboxStorageRunIsActive(mounted.runStatus);
    if (terminalRetry) {
      const parentVersionId = args.parentVersionId;
      const version = await findStorageVersion({
        db: writeDb,
        storageId: mounted.storage.id,
        versionId: args.versionId,
      });
      signal.throwIfAborted();
      if (
        !parentVersionId ||
        !terminalStorageCommitPersistedStateMatches({
          storage: mounted.storage,
          version,
          input: commitInput,
        })
      ) {
        return notFound("Active agent run not found");
      }

      const [lineage] = await writeDb
        .select({ id: storageVersionLineage.id })
        .from(storageVersionLineage)
        .where(
          and(
            eq(storageVersionLineage.storageId, mounted.storage.id),
            eq(storageVersionLineage.versionId, args.versionId),
            eq(storageVersionLineage.parentVersionId, parentVersionId),
            eq(storageVersionLineage.runId, args.auth.runId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!lineage) {
        return notFound("Active agent run not found");
      }
    }

    const response = await set(
      commitStorageUploadForStorage$,
      commitInput,
      signal,
    );
    return terminalRetry && response.status !== 200
      ? notFound("Active agent run not found")
      : response;
  },
);
