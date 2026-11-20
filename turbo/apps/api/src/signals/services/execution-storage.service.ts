import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_PI_MEMORY_MOUNT_PATH,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import {
  MEMORY_ARTIFACT_NAME,
  SYSTEM_ORG_ID,
} from "@okouai/core/storage-names";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command } from "ccstate";
import { env } from "../../lib/env";
import { publicPresignedGetUrlSigner$ } from "../external/s3";
import type { MemberMemoryOwner } from "./member-memory";
import type { MemberMemoryHead } from "./member-memory-head.service";
import { isMemberMemoryIdentity } from "./member-memory-records";
import {
  readOnlyStorageSigningRequest,
  signStoragePresignedUrls,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** The accepted source and its existing persisted projection travel together. */
export interface AcceptedMemoryMount {
  readonly mount: PersistedStorageMount & {
    readonly version: string;
    readonly writeback: true;
    readonly missingRootPolicy: "preserveParentVersion";
  };
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly archiveCache: MemberMemoryHead["archiveCache"];
}

const memoryMountPaths = Object.freeze({
  "claude-code": CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  codex: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  pi: CANONICAL_PI_MEMORY_MOUNT_PATH,
});

export function buildMemberMemoryMount(
  owner: MemberMemoryOwner,
  head: MemberMemoryHead,
  framework: keyof typeof memoryMountPaths,
): AcceptedMemoryMount {
  const mount = {
    ...owner,
    name: MEMORY_ARTIFACT_NAME,
    storageId: head.storageId,
    version: head.versionId,
    mountPath: memoryMountPaths[framework],
    writeback: true as const,
    missingRootPolicy: "preserveParentVersion" as const,
  };
  if (!isMemberMemoryIdentity(mount) || mount.orgId === SYSTEM_ORG_ID) {
    throw new Error("Execution writeback requires member Memory");
  }
  return {
    mount,
    s3Key: head.s3Key,
    archiveSize: head.archiveSize,
    fileCount: head.fileCount,
    archiveCache: head.archiveCache,
  };
}

interface ExecutionStorage {
  readonly storageMounts: StoredStorageMountEntry[];
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
}

/** Sign the accepted archive at dispatch time using its captured cache row. */
export const prepareAcceptedExecutionStorage$ = command(
  async (
    { get },
    mounts: readonly AcceptedMemoryMount[],
    signal: AbortSignal,
  ): Promise<ExecutionStorage> => {
    signal.throwIfAborted();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const selected = mounts.map(({ mount, s3Key, archiveSize, fileCount }) => {
      const identity = {
        orgId: mount.orgId,
        userId: mount.userId,
        storageId: mount.storageId,
        versionId: mount.version,
        name: mount.name,
        mountPath: mount.mountPath,
        writeback: mount.writeback,
        missingRootPolicy: mount.missingRootPolicy,
      };
      const request =
        fileCount === 0
          ? undefined
          : readOnlyStorageSigningRequest({
              bucket,
              objectKey: `${s3Key}/archive.tar.gz`,
              storageVersionId: mount.version,
              resolvedOrgId: mount.orgId,
            });
      return { identity, archiveSize, request };
    });
    const readOnlyRequests = selected.flatMap(({ request }) => {
      return request ? [request] : [];
    });
    const signed =
      readOnlyRequests.length === 0
        ? undefined
        : await signStoragePresignedUrls({
            requests: readOnlyRequests,
            rows: mounts.flatMap(({ archiveCache }) => {
              return archiveCache ? [archiveCache] : [];
            }),
            sign: get(publicPresignedGetUrlSigner$),
          });
    signal.throwIfAborted();
    return {
      storageMounts: selected.map(({ identity, request, archiveSize }) => {
        if (!request) {
          return { ...identity, empty: true as const };
        }
        const archiveUrl = signed?.results.get(request.cacheKey)?.url;
        if (!archiveUrl) {
          throw new Error("Prepared storage URL is missing");
        }
        return {
          ...identity,
          archiveUrl,
          ...(archiveSize > 0 ? { archiveSize } : {}),
        };
      }),
      cacheWrites: signed?.freshValues ?? [],
    };
  },
);
