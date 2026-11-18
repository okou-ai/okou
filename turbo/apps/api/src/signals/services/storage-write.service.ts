import type {
  CommitStorageUploadInput,
  CommitStorageForStorageInput,
  CommitStorageResponse,
  StorageErrorResponse,
  StorageRow,
  StorageVersionRow,
  VerifiedStorageCommit,
} from "./storage-write-protocol";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import { MAX_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/storages";
import type { MemoryMergeContext } from "@okouai/api-contracts/contracts/webhooks";
import {
  memberMemories,
  memoryVersions,
  memoryVersionLineage,
} from "@okouai/db/schema/member-memory";
import {
  memberMemoryStorageRecord,
  memberMemoryVersionRecord,
  isMemberMemoryIdentity,
} from "./member-memory-records";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { command } from "ccstate";
import { and, eq, ne, or, sql } from "drizzle-orm";

import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { db$, writeDb$ } from "../external/db";
import {
  downloadManifest,
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  s3ObjectExists,
  s3ObjectHead,
  type S3ObjectHead,
} from "../external/s3";
import { storageCommitLineageCondition } from "./storage-write-conditions";
import {
  memberMemoryMergeVersions,
  memberMemorySnapshotSource,
} from "./member-memory";
import {
  sandboxStorageRunIsActive,
  storageCommitPublicationStatement,
  storageCommitPublicationRow,
  storageCommitPublicationResult,
  terminalStorageCommitPersistedStateMatches,
  totalSize,
} from "./storage-write-publication-plan";

interface StorageChanges {
  readonly deleted?: readonly string[];
}

interface PrepareStorageUploadInput {
  readonly files: readonly FileEntryWithHash[];
  readonly force?: boolean;
  readonly runId?: string;
  readonly parentVersionId?: string;
  readonly baseVersion?: string;
  readonly changes?: StorageChanges;
  readonly includeMemoryMerge?: boolean;
}

interface PrepareStorageInput extends PrepareStorageUploadInput {
  readonly auth: SandboxAuth;
  readonly storageId: string;
}

interface CommitStorageInput extends CommitStorageUploadInput {
  readonly auth: SandboxAuth;
  readonly storageId: string;
}

interface MountedWritebackStorage {
  readonly runStatus: typeof agentRuns.$inferSelect.status;
  readonly storage: StorageRow;
  readonly capturedVersionId: string | undefined;
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

type PrepareStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly versionId: string;
        readonly existing: boolean;
        readonly memoryMerge?: MemoryMergeContext;
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
    // Observe Run authority and Memory in one statement. Retained non-Memory
    // mounts resolve separately, so Memory never queries the legacy registry.
    const [mounted] = await get(db$)
      .select({
        runStatus: agentRuns.status,
        storageMounts: agentRuns.storageMounts,
        memory: memberMemories,
      })
      .from(agentRuns)
      .leftJoin(
        memberMemories,
        and(
          eq(memberMemories.id, args.storageId),
          sql`EXISTS (SELECT 1 FROM (
          SELECT entry.value FROM jsonb_array_elements(${agentRuns.storageMounts}) WITH ORDINALITY AS entry(value,position)
          WHERE entry.value->>'storageId'=${args.storageId} AND entry.value->'writeback'='true'::jsonb ORDER BY entry.position LIMIT 1
        ) AS mount WHERE mount.value->>'orgId'=${memberMemories.orgId}
          AND mount.value->>'userId'=${memberMemories.userId} AND mount.value->>'name'=${MEMORY_ARTIFACT_NAME})`,
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
    const mount = mounted.storageMounts?.find((entry) => {
      return entry.storageId === args.storageId && entry.writeback === true;
    });
    if (!mount) {
      return notFound("Writeback storage not found");
    }
    if (isMemberMemoryIdentity(mount)) {
      if (!mounted.memory) {
        throw new Error("Accepted member Memory authority is unavailable");
      }
      return {
        runStatus: mounted.runStatus,
        storage: memberMemoryStorageRecord(mounted.memory),
        capturedVersionId: mount.version,
      };
    }
    const [storage] = await get(db$)
      .select(storageRowSelection())
      .from(storages)
      .where(
        and(
          eq(storages.id, args.storageId),
          eq(storages.orgId, mount.orgId),
          eq(storages.userId, mount.userId),
          eq(storages.name, mount.name),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return storage
      ? {
          runStatus: mounted.runStatus,
          storage,
          capturedVersionId: mount.version,
        }
      : notFound("Writeback storage not found");
  },
);

const findStorageVersion$ = command(
  async (
    { get },
    args: {
      readonly storage: StorageRow;
      readonly versionId: string;
    },
    signal: AbortSignal,
  ): Promise<StorageVersionRow | undefined> => {
    if (isMemberMemoryIdentity(args.storage)) {
      const [memory] = await get(db$)
        .select()
        .from(memoryVersions)
        .where(
          and(
            eq(memoryVersions.memoryId, args.storage.id),
            eq(memoryVersions.id, args.versionId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return memory ? memberMemoryVersionRecord(memory) : undefined;
    }
    const [version] = await get(db$)
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storage.id),
          eq(storageVersions.id, args.versionId),
        ),
      )
      .limit(1);

    signal.throwIfAborted();
    return version;
  },
);

/** Refresh the already-authorized owner's row without probing another registry. */
const refreshOwnedStorage$ = command(
  async (
    { get },
    owner: StorageRow,
    signal: AbortSignal,
  ): Promise<StorageRow | undefined> => {
    const db = get(db$);
    if (isMemberMemoryIdentity(owner)) {
      const [memory] = await db
        .select()
        .from(memberMemories)
        .where(eq(memberMemories.id, owner.id))
        .limit(1);
      signal.throwIfAborted();
      return memory ? memberMemoryStorageRecord(memory) : undefined;
    }
    const [storage] = await db
      .select(storageRowSelection())
      .from(storages)
      .where(
        and(
          eq(storages.id, owner.id),
          or(
            ne(storages.name, MEMORY_ARTIFACT_NAME),
            eq(storages.userId, "__org__"),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return storage;
  },
);

/** Keep Memory's immutable download capabilities inside its existing publication owner. */
const prepareMemoryMergeContext$ = command(
  async (
    { get, set },
    args: { readonly storage: StorageRow; readonly baseVersionId: string },
    signal: AbortSignal,
  ): Promise<MemoryMergeContext> => {
    const versions = memberMemoryMergeVersions(
      args.baseVersionId,
      args.storage.headVersionId,
    );
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const snapshots = await Promise.all(
      versions.map(async (versionId) => {
        const version = await set(
          findStorageVersion$,
          { storage: args.storage, versionId },
          signal,
        );
        const source = memberMemorySnapshotSource({
          objectPrefix: args.storage.s3Prefix,
          versionId,
          revision: version
            ? { objectPrefix: version.s3Key, fileCount: version.fileCount }
            : undefined,
        });
        if (source.empty) {
          return source;
        }
        const [manifestUrl, archiveUrl] = await Promise.all([
          get(
            generatePresignedGetUrl(
              bucket,
              source.manifestKey,
              undefined,
              true,
            ),
          ),
          get(
            generatePresignedGetUrl(bucket, source.archiveKey, undefined, true),
          ),
        ]);
        signal.throwIfAborted();
        return { versionId, empty: false, manifestUrl, archiveUrl };
      }),
    );
    signal.throwIfAborted();
    const [base, head] = snapshots;
    if (!base || !head) {
      throw new Error("Memory merge snapshots are unavailable");
    }
    return { base, head };
  },
);

const resolvePreparedFiles$ = command(
  async (
    { get, set },
    args: {
      readonly bucket: string;
      readonly storage: StorageRow;
      readonly input: PrepareStorageUploadInput;
    },
    signal: AbortSignal,
  ): Promise<readonly FileEntryWithHash[]> => {
    const baseVersion = args.input.baseVersion;
    const changes = args.input.changes;
    if (!baseVersion || !changes) {
      return args.input.files;
    }
    const baseVersionRecord = await set(
      findStorageVersion$,
      { storage: args.storage, versionId: baseVersion },
      signal,
    );
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
      readonly storage: StorageRow;
    },
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const db = set(writeDb$);
    const query = storageCommitPublicationStatement(
      args.input,
      args.verification,
      nowDate(),
      args.storage,
    );
    signal.throwIfAborted();
    const [row] = parseRawRows(
      storageCommitPublicationRow,
      await db.execute(query),
    );
    // A submitted statement can commit before cancellation is observed. A SQL
    // error still rolls back every dependent write and remains the primary error.
    signal.throwIfAborted();
    return storageCommitPublicationResult(row, args.input);
  },
);

const prepareStorageUploadForStorage$ = command(
  async (
    { set },
    args: PrepareStorageUploadInput,
    owner: StorageRow,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const declaredSize = totalSize(args.files);
    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      return payloadTooLarge(
        "Upload rejected: total file size exceeds 100MB limit",
      );
    }

    const storage = await set(refreshOwnedStorage$, owner, signal);
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
      { bucket, storage, input: args },
      signal,
    );
    signal.throwIfAborted();
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);

    const existingVersion = await set(
      findStorageVersion$,
      { storage, versionId },
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

const commitStorageUploadForStorage$ = command(
  async (
    { set },
    args: CommitStorageForStorageInput,
    owner: StorageRow,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const storage = await set(refreshOwnedStorage$, owner, signal);
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
      { storage, versionId: args.versionId },
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
      { input: args, verification, storage },
      signal,
    );
  },
);

/** The legacy wire also retains authorization for accepted historical mounts. */
export const prepareMemberMemoryWriteback$ = command(
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

    const response = await set(
      prepareStorageUploadForStorage$,
      {
        files: args.files,
        force: args.force,
        runId: args.runId,
        parentVersionId: args.parentVersionId,
        baseVersion: args.baseVersion,
        changes: args.changes,
      },
      mounted.storage,
      signal,
    );
    signal.throwIfAborted();
    if (response.status !== 200) {
      return response;
    }

    let memoryMerge: MemoryMergeContext | undefined;
    if (
      args.includeMemoryMerge &&
      mounted.storage.name === MEMORY_ARTIFACT_NAME
    ) {
      if (!mounted.capturedVersionId) {
        throw new Error("Memory mount has no captured base version");
      }
      memoryMerge = await set(
        prepareMemoryMergeContext$,
        { storage: mounted.storage, baseVersionId: mounted.capturedVersionId },
        signal,
      );
    }

    // This final observation authorizes only the response. Commit revalidates
    // under its own run/storage authorization before any publication.
    const current = await set(
      readMountedWritebackStorage$,
      { auth: args.auth, storageId: args.storageId },
      signal,
    );
    const admitted = !(
      "status" in current || !sandboxStorageRunIsActive(current.runStatus)
    );
    signal.throwIfAborted();
    return admitted
      ? {
          ...response,
          body: { ...response.body, ...(memoryMerge ? { memoryMerge } : {}) },
        }
      : notFound("Active agent run not found");
  },
);

const readSandboxLineage$ = command(
  async (
    { get },
    input: {
      readonly storage: StorageRow;
      readonly versionId: string;
      readonly parentVersionId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ) => {
    if (isMemberMemoryIdentity(input.storage)) {
      const [lineage] = await get(db$)
        .select()
        .from(memoryVersionLineage)
        .where(
          and(
            eq(memoryVersionLineage.memoryId, input.storage.id),
            eq(memoryVersionLineage.versionId, input.versionId),
            eq(memoryVersionLineage.parentVersionId, input.parentVersionId),
            eq(memoryVersionLineage.runId, input.runId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return lineage;
    }
    const [lineage] = await get(db$)
      .select()
      .from(storageVersionLineage)
      .where(
        storageCommitLineageCondition(
          input.storage.id,
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

export const commitMemberMemoryWriteback$ = command(
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
    const terminalRetry = !sandboxStorageRunIsActive(mounted.runStatus);
    if (terminalRetry) {
      const version = await set(
        findStorageVersion$,
        { storage: mounted.storage, versionId: args.versionId },
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
          storage: mounted.storage,
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
    const response = await set(
      commitStorageUploadForStorage$,
      input,
      mounted.storage,
      signal,
    );
    return terminalRetry && response.status !== 200
      ? notFound("Active agent run not found")
      : response;
  },
);
