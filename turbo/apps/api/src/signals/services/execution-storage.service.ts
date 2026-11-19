import type { StoredStorageMountEntry } from "@okouai/api-contracts/contracts/runners";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command } from "ccstate";
import { env } from "../../lib/env";
import { publicPresignedGetUrlSigner$ } from "../external/s3";
import type { ExecutionStorageCacheRows } from "./execution-storage-cache-read.service";
import {
  readOnlyStoragePresignedUrlCacheKey,
  signStorageManifestPresignedUrls,
  type SelectedStoragePresignedUrlCacheRow,
  type StorageManifestPresignedUrlCacheScope,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** The accepted source and its existing persisted projection travel together. */
export interface AcceptedMemoryMount {
  readonly mount: PersistedStorageMount & {
    readonly version: string;
    readonly writeback: true;
  };
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly cachedUrls: ExecutionStorageCacheRows;
}

interface ExecutionStorage {
  readonly storageMounts: StoredStorageMountEntry[];
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
}

function cacheSnapshot(mounts: readonly AcceptedMemoryMount[]) {
  const rowsByScope = new Map<
    StorageManifestPresignedUrlCacheScope,
    Map<string, SelectedStoragePresignedUrlCacheRow>
  >();
  for (const { cachedUrls } of mounts) {
    for (const row of cachedUrls) {
      let scoped = rowsByScope.get(row.scope);
      if (!scoped) {
        scoped = new Map();
        rowsByScope.set(row.scope, scoped);
      }
      scoped.set(row.cacheKey, row);
    }
  }
  return { rowsByScope };
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
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      };
      const request =
        fileCount === 0
          ? undefined
          : {
              bucket,
              objectKey: `${s3Key}/archive.tar.gz`,
              storageVersionId: mount.version,
              resolvedOrgId: mount.orgId,
              publicEndpoint: true,
            };
      return { identity, archiveSize, request };
    });
    const readOnlyRequests = selected.flatMap(({ request }) => {
      return request ? [request] : [];
    });
    const signed =
      readOnlyRequests.length === 0
        ? undefined
        : await signStorageManifestPresignedUrls({
            input: { systemRequests: [], readOnlyRequests },
            prefetchedRows: cacheSnapshot(mounts),
            sign: get(publicPresignedGetUrlSigner$),
          });
    signal.throwIfAborted();
    return {
      storageMounts: selected.map(({ identity, request, archiveSize }) => {
        if (!request) {
          return { ...identity, empty: true as const };
        }
        const archiveUrl = signed?.results.get(
          readOnlyStoragePresignedUrlCacheKey(request),
        )?.url;
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
