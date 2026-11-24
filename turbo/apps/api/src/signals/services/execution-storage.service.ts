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
  readonly head: MemberMemoryHead;
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
  return { mount, head };
}

export interface ExecutionMemoryMount {
  readonly mount: StoredStorageMountEntry;
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
}

interface ExecutionMemoryArchive {
  readonly entry:
    | { readonly empty: true }
    | { readonly archiveUrl: string; readonly archiveSize?: number };
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
}

export function executionMemoryMount(
  mount: AcceptedMemoryMount["mount"],
  archive: ExecutionMemoryArchive,
): ExecutionMemoryMount {
  const { version, ...identity } = mount;
  return {
    mount: { ...identity, versionId: version, ...archive.entry },
    cacheWrites: archive.cacheWrites,
  };
}

/** Prepare the selected archive before the runner mount path is known. */
export const prepareExecutionMemoryArchive$ = command(
  async (
    { get },
    owner: MemberMemoryOwner,
    head: MemberMemoryHead,
    signal: AbortSignal,
  ): Promise<ExecutionMemoryArchive> => {
    signal.throwIfAborted();
    const { s3Key, archiveSize, fileCount, archiveCache, versionId } = head;
    if (fileCount === 0) {
      return { entry: { empty: true }, cacheWrites: [] };
    }
    const request = readOnlyStorageSigningRequest({
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
      objectKey: `${s3Key}/archive.tar.gz`,
      storageVersionId: versionId,
      resolvedOrgId: owner.orgId,
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
      entry: {
        archiveUrl,
        ...(archiveSize > 0 ? { archiveSize } : {}),
      },
      cacheWrites: signed.freshValues,
    };
  },
);
