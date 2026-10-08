import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import { MAX_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/storages";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { parseRawRows } from "../../lib/db-raw-rows";
import { badRequestMessage, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { db$, writeDb$ } from "../external/db";
import {
  downloadManifest,
  generatePresignedPutUrl,
  s3ObjectExists,
  s3ObjectHead,
  type S3ObjectHead,
} from "../external/s3";
import {
  maintenanceCallbackCondition,
  storageMaintenanceReceiptCondition,
  storageMaintenanceJobCondition,
  storageCommitLineageCondition,
  type MaintenanceReceiptBinding,
} from "./storage-write-conditions";
import {
  storageCommitPublicationPlan,
  sandboxStorageRunIsActive,
  maintenancePublicationBinding,
  maintenanceCheckpointBinding,
  totalSize,
  terminalStorageCommitPersistedStateMatches,
  storageCommitSuccess,
  type MaintenancePublicationInput,
} from "./storage-write-publication-plan";

interface StorageChanges {
  readonly deleted?: readonly string[];
}

export interface PiMemoryPhase2CheckpointAttestation {
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

export interface CommitStorageForStorageInput extends CommitStorageUploadInput {
  readonly storageId: string;
  readonly sandboxAuth?: SandboxAuth;
}

export type StorageRow = typeof storages.$inferSelect;
export type StorageVersionRow = typeof storageVersions.$inferSelect;

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

export type StorageErrorResponse =
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

export type CommitStorageResponse =
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
  | StorageErrorResponse;

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

const readMountedWritebackStorage$ = command(
  async (
    { get },
    args: { readonly auth: SandboxAuth; readonly storageId: string },
    signal: AbortSignal,
  ): Promise<MountedWritebackStorage | StorageErrorResponse> => {
    // One statement observes run authority and its first matching writeback mount
    // together with the exact Storage identity. Ordinality preserves Array.find.
    const [mounted] = await get(db$)
      .select({ runStatus: agentRuns.status, storage: storageRowSelection() })
      .from(agentRuns)
      .leftJoin(
        storages,
        and(
          eq(storages.id, args.storageId),
          sql`EXISTS (
      SELECT 1 FROM (
        SELECT entry.value FROM jsonb_array_elements(${agentRuns.storageMounts}) WITH ORDINALITY AS entry(value, position)
        WHERE entry.value->>'storageId' = ${args.storageId}
          AND entry.value->'writeback' = 'true'::jsonb
        ORDER BY entry.position LIMIT 1
      ) AS mount
      WHERE mount.value->>'orgId' = ${storages.orgId}
        AND mount.value->>'userId' = ${storages.userId}
        AND mount.value->>'name' = ${storages.name}
    )`,
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.auth.runId),
          eq(agentRuns.userId, args.auth.userId),
          eq(agentRuns.orgId, args.auth.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!mounted) {
      return notFound("Agent run not found");
    }
    return mounted.storage
      ? { runStatus: mounted.runStatus, storage: mounted.storage }
      : notFound("Writeback storage not found");
  },
);

const guardMaintenancePreparation$ = command(
  async ({ get }, args: MaintenancePublicationInput, signal: AbortSignal) => {
    const db = get(db$);
    const [callback] = await db
      .select({ payload: agentRunCallbacks.payload })
      .from(agentRunCallbacks)
      .where(maintenanceCallbackCondition(args.auth.runId))
      .limit(1);
    signal.throwIfAborted();
    const binding = maintenancePublicationBinding(callback?.payload, args);
    if (!binding || "status" in binding) {
      return binding;
    }
    const [receipt] = await db
      .select()
      .from(piMemoryPhase2Checkpoints)
      .where(storageMaintenanceReceiptCondition(binding))
      .limit(1);
    signal.throwIfAborted();
    if (receipt) {
      return notFound("Pi memory maintenance checkpoint already committed");
    }
    const [active] = await db
      .select()
      .from(piMemoryPhase2Jobs)
      .where(storageMaintenanceJobCondition(binding, nowDate()))
      .limit(1)
      .for("update", { of: piMemoryPhase2Jobs });
    signal.throwIfAborted();
    return active
      ? undefined
      : notFound("Active Pi memory maintenance publication not found");
  },
);

const findStorageVersion$ = command(
  async (
    { get },
    args: {
      readonly storageId: string;
      readonly versionId: string;
    },
    signal: AbortSignal,
  ): Promise<StorageVersionRow | undefined> => {
    const [version] = await get(db$)
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, args.versionId),
        ),
      )
      .limit(1);

    signal.throwIfAborted();
    return version;
  },
);

const findStorageById$ = command(
  async (
    { get },
    args: {
      readonly storageId: string;
    },
    signal: AbortSignal,
  ): Promise<StorageRow | undefined> => {
    const [storage] = await get(db$)
      .select(storageRowSelection())
      .from(storages)
      .where(eq(storages.id, args.storageId))
      .limit(1);

    signal.throwIfAborted();
    return storage;
  },
);

const resolvePreparedFiles$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly storageId: string;
      readonly input: PrepareStorageUploadInput;
    },
    signal: AbortSignal,
  ): Promise<readonly FileEntryWithHash[]> => {
    const baseVersion = args.input.baseVersion;
    const changes = args.input.changes;
    if (!baseVersion || !changes) {
      return args.input.files;
    }
    const [baseVersionRecord] = await get(db$)
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, baseVersion),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!baseVersionRecord || baseVersionRecord.fileCount === 0) {
      return args.input.files;
    }
    const baseManifest = await get(
      downloadManifest(args.bucket, baseVersionRecord.s3Key),
    );
    signal.throwIfAborted();
    const currentFiles = new Map(
      args.input.files.map((file) => {
        return [file.path, file];
      }),
    );
    const deleted = new Set(changes.deleted ?? []);
    const baseFiles = baseManifest.files.filter((file) => {
      return !deleted.has(file.path) && !currentFiles.has(file.path);
    });
    return [...baseFiles, ...args.input.files];
  },
);

const createStorageUploadResponse$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly storage: StorageRow;
      readonly versionId: string;
    },
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const s3Key = `${args.storage.s3Prefix}/${args.versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;
    const [archiveUrl, manifestUrl] = await Promise.all([
      get(
        generatePresignedPutUrl(
          args.bucket,
          archiveKey,
          "application/gzip",
          { usePublicEndpoint: true },
          signal,
        ),
      ),
      get(
        generatePresignedPutUrl(
          args.bucket,
          manifestKey,
          "application/json",
          { usePublicEndpoint: true },
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
  },
);

type ArchiveVerification =
  | { readonly kind: "verified"; readonly archiveSize: number }
  | { readonly kind: "missing-archive" }
  | { readonly kind: "invalid-archive-size" };

type UploadedStorageFilesVerification =
  ArchiveVerification | { readonly kind: "missing-manifest" };

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

const verifyUploadedStorageFiles$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly s3Key: string;
      readonly fileCount: number;
    },
    signal: AbortSignal,
  ): Promise<UploadedStorageFilesVerification> => {
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
  },
);

export interface VerifiedStorageCommit {
  readonly archiveSize: number;
  readonly s3Key: string;
}

const verifyStorageCommit$ = command(
  async (
    { set },
    args: {
      readonly bucket: string;
      readonly storage: StorageRow;
      readonly version: StorageVersionRow | undefined;
      readonly input: CommitStorageUploadInput;
    },
    signal: AbortSignal,
  ): Promise<VerifiedStorageCommit | CommitStorageResponse> => {
    // Registration follows successful upload verification. Reuse its
    // committed metadata without probing the objects again.
    if (args.version) {
      return {
        archiveSize: args.version.archiveSize,
        s3Key: args.version.s3Key,
      };
    }

    const s3Key = `${args.storage.s3Prefix}/${args.input.versionId}`;
    const verification = await set(
      verifyUploadedStorageFiles$,
      { bucket: args.bucket, s3Key, fileCount: args.input.files.length },
      signal,
    );
    signal.throwIfAborted();

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

const commitVerifiedStorageVersion$ = command(
  async (
    { set },
    args: {
      readonly input: CommitStorageForStorageInput;
      readonly verification: VerifiedStorageCommit;
    },
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    return await set(writeDb$).transaction(async (tx) => {
      // The plan contains only bound SQL and ordinary data. This command alone
      // executes every statement and owns the transaction through completion.
      const plan = storageCommitPublicationPlan(args.input, args.verification);
      let step = plan.next();
      while (!step.done) {
        const statement = step.value;
        let rows: readonly unknown[] = [];
        if (statement.rowSchema) {
          rows = parseRawRows(
            statement.rowSchema,
            await tx.execute(statement.sql),
          );
        } else {
          await tx.execute(statement.sql);
        }
        signal.throwIfAborted();
        step = plan.next(rows);
      }
      return step.value;
    });
  },
);

export const prepareStorageUploadForStorage$ = command(
  async (
    { set },
    args: PrepareStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const declaredSize = totalSize(args.files);
    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      return payloadTooLarge(
        "Upload rejected: total file size exceeds 100MB limit",
      );
    }

    const storage = await set(
      findStorageById$,
      { storageId: args.storageId },
      signal,
    );
    signal.throwIfAborted();

    if (!storage) {
      return notFound("Storage not found");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const mergedFiles = await set(
      resolvePreparedFiles$,
      { bucket, storageId: storage.id, input: args },
      signal,
    );
    signal.throwIfAborted();
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);

    const existingVersion = await set(
      findStorageVersion$,
      { storageId: storage.id, versionId },
      signal,
    );
    signal.throwIfAborted();
    if (existingVersion) {
      return { status: 200, body: { versionId, existing: true } };
    }

    return await set(
      createStorageUploadResponse$,
      { bucket, storage, versionId },
      signal,
    );
  },
);

export const commitStorageUploadForStorage$ = command(
  async (
    { set },
    args: CommitStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const storage = await set(
      findStorageById$,
      { storageId: args.storageId },
      signal,
    );
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

    const existingVersion = await set(
      findStorageVersion$,
      { storageId: storage.id, versionId: args.versionId },
      signal,
    );
    signal.throwIfAborted();

    const verification = await set(
      verifyStorageCommit$,
      { bucket, storage, version: existingVersion, input: args },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in verification) {
      return verification;
    }

    return await set(
      commitVerifiedStorageVersion$,
      { input: args, verification },
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
    const mounted = await set(
      readMountedWritebackStorage$,
      { auth: args.auth, storageId: args.storageId },
      signal,
    );
    signal.throwIfAborted();

    if ("status" in mounted) {
      return mounted;
    }
    if (!sandboxStorageRunIsActive(mounted.runStatus)) {
      return notFound("Active agent run not found");
    }

    const maintenanceGuard = await set(
      guardMaintenancePreparation$,
      {
        auth: args.auth,
        storageId: args.storageId,
        parentVersionId: args.parentVersionId,
        versionId: computeContentHashFromHashes(args.storageId, args.files),
        attestation: args.maintenanceAttestation,
      },
      signal,
    );
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

    // This final observation authorizes only the response. Commit revalidates
    // under its own run/storage/maintenance fences before any publication.
    const current = await set(
      readMountedWritebackStorage$,
      { auth: args.auth, storageId: args.storageId },
      signal,
    );
    const admitted = !(
      "status" in current || !sandboxStorageRunIsActive(current.runStatus)
    );
    signal.throwIfAborted();
    return admitted ? response : notFound("Active agent run not found");
  },
);

const readSandboxReceipt$ = command(
  async ({ get }, binding: MaintenanceReceiptBinding, signal: AbortSignal) => {
    const [receipt] = await get(db$)
      .select()
      .from(piMemoryPhase2Checkpoints)
      .where(storageMaintenanceReceiptCondition(binding))
      .limit(1);
    signal.throwIfAborted();
    return receipt;
  },
);

const readSandboxLineage$ = command(
  async (
    { get },
    input: {
      readonly storageId: string;
      readonly versionId: string;
      readonly parentVersionId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ) => {
    const [lineage] = await get(db$)
      .select()
      .from(storageVersionLineage)
      .where(
        storageCommitLineageCondition(
          input.storageId,
          input.versionId,
          input.parentVersionId,
          input.runId,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return lineage;
  },
);

export const commitSandboxStorageUpload$ = command(
  async (
    { set },
    args: CommitStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const input: CommitStorageForStorageInput = {
      ...args,
      sandboxAuth: args.auth,
    };
    const mounted = await set(
      readMountedWritebackStorage$,
      { auth: args.auth, storageId: args.storageId },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in mounted) {
      return mounted;
    }
    const binding = maintenanceCheckpointBinding(input);
    const receipt = binding
      ? await set(readSandboxReceipt$, binding, signal)
      : undefined;
    if (receipt) {
      if (
        receipt.versionId !== args.versionId ||
        computeContentHashFromHashes(args.storageId, args.files) !==
          receipt.versionId
      ) {
        return notFound("Pi memory maintenance checkpoint replay mismatch");
      }
      const version = await set(
        findStorageVersion$,
        { storageId: args.storageId, versionId: args.versionId },
        signal,
      );
      signal.throwIfAborted();
      return version
        ? storageCommitSuccess({
            storage: mounted.storage,
            versionId: version.id,
            size: Number(version.size),
            fileCount: version.fileCount,
            deduplicated: true,
          })
        : notFound("Pi memory maintenance checkpoint version not found");
    }
    const terminalRetry = !sandboxStorageRunIsActive(mounted.runStatus);
    if (terminalRetry) {
      const version = await set(
        findStorageVersion$,
        { storageId: args.storageId, versionId: args.versionId },
        signal,
      );
      if (
        !args.parentVersionId ||
        !terminalStorageCommitPersistedStateMatches({
          storage: mounted.storage,
          version,
          input,
        })
      ) {
        return notFound("Active agent run not found");
      }
      const lineage = await set(
        readSandboxLineage$,
        {
          storageId: args.storageId,
          versionId: args.versionId,
          parentVersionId: args.parentVersionId,
          runId: args.auth.runId,
        },
        signal,
      );
      if (!lineage) {
        return notFound("Active agent run not found");
      }
    }
    const response = await set(commitStorageUploadForStorage$, input, signal);
    return terminalRetry && response.status !== 200
      ? notFound("Active agent run not found")
      : response;
  },
);
