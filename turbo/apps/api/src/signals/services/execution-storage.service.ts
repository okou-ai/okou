import type { StoredStorageMountEntry } from "@okouai/api-contracts/contracts/runners";
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

export function buildMemberMemoryMount(
  owner: MemberMemoryOwner,
  head: MemberMemoryHead,
  mountPath: string,
): AcceptedMemoryMount {
  const mount = {
    ...owner,
    name: MEMORY_ARTIFACT_NAME,
    storageId: head.storageId,
    version: head.versionId,
    mountPath,
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

interface ExecutionMemoryMount {
  readonly mount: StoredStorageMountEntry;
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
}

/** Sign the accepted archive at dispatch time using its captured cache row. */
export const prepareExecutionMemoryMount$ = command(
  async (
    { get },
    memory: AcceptedMemoryMount,
    signal: AbortSignal,
  ): Promise<ExecutionMemoryMount> => {
    signal.throwIfAborted();
    const { mount, s3Key, archiveSize, fileCount, archiveCache } = memory;
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
    if (fileCount === 0) {
      return { mount: { ...identity, empty: true }, cacheWrites: [] };
    }
    const request = readOnlyStorageSigningRequest({
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
      objectKey: `${s3Key}/archive.tar.gz`,
      storageVersionId: mount.version,
      resolvedOrgId: mount.orgId,
    });
    const signed = await signStoragePresignedUrls({
      requests: [request],
      rows: archiveCache ? [archiveCache] : [],
      sign: get(publicPresignedGetUrlSigner$),
    });
    signal.throwIfAborted();
    const archiveUrl = signed.results.get(request.cacheKey)?.url;
    if (!archiveUrl) {
      throw new Error("Prepared Memory archive URL is missing");
    }
    return {
      mount: {
        ...identity,
        archiveUrl,
        ...(archiveSize > 0 ? { archiveSize } : {}),
      },
      cacheWrites: signed.freshValues,
    };
  },
);
