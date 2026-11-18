import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { isMemberMemoryIdentity } from "./member-memory-records";
import {
  MEMORY_ARTIFACT_NAME,
  SYSTEM_ORG_ID,
} from "@okouai/core/storage-names";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { and, eq, or, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { publicPresignedGetUrlSigner$ } from "../external/s3";
import { db$ } from "../external/db";
import {
  cacheRowsFromProjection,
  storageVersionCacheKeySql,
  type ExecutionStorageCacheRows,
} from "./execution-storage-cache-read.service";
import {
  readOnlyStoragePresignedUrlCacheKey,
  signStorageManifestPresignedUrls,
  systemStoragePresignedUrlCacheKey,
  type SelectedStoragePresignedUrlCacheRow,
  type StorageManifestPresignedUrlCacheScope,
} from "./system-storage-presigned-url-cache.service";

export interface ExecutionStorageIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly storageId: string;
  readonly versionId: string;
  readonly name: string;
  readonly mountPath: string;
}

export interface ReadOnlyStorageRequest extends ExecutionStorageIdentity {
  readonly mode: "readonly";
}

export interface WritebackStorageRequest extends ExecutionStorageIdentity {
  readonly mode: "writeback";
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export type ExecutionStorageRequest =
  ReadOnlyStorageRequest | WritebackStorageRequest;
export type PreparedStorageIdentity = ExecutionStorageIdentity;

/**
 * A URL this preparation signed fresh rather than read from the cache. Only
 * the post-commit cache write reads it.
 */
type PresignedUrlCacheWrite = FreshCacheValues[number];

export interface PreparedReadOnlyMount extends PreparedStorageIdentity {
  readonly writeback: false;
  readonly archiveUrl: string;
  readonly archiveSize: number;
  readonly presignedUrlCacheWrite?: PresignedUrlCacheWrite;
}

export interface PreparedArchivedWritebackMount extends PreparedStorageIdentity {
  readonly writeback: true;
  readonly empty: false;
  readonly archiveUrl: string;
  readonly archiveSize: number;
  readonly presignedUrlCacheWrite?: PresignedUrlCacheWrite;
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export interface PreparedEmptyWritebackMount extends PreparedStorageIdentity {
  readonly writeback: true;
  readonly empty: true;
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export type PreparedExecutionStorageMount =
  | PreparedReadOnlyMount
  | PreparedArchivedWritebackMount
  | PreparedEmptyWritebackMount;
export interface ExecutionStorageObjects {
  readonly preparedMounts$: Computed<
    Promise<readonly PreparedExecutionStorageMount[]>
  >;
}

type CacheInput = Parameters<
  typeof signStorageManifestPresignedUrls
>[0]["input"];
type CacheSnapshot = Parameters<
  typeof signStorageManifestPresignedUrls
>[0]["prefetchedRows"];
type FreshCacheValues = Awaited<
  ReturnType<typeof signStorageManifestPresignedUrls>
>["freshValues"];

function mountKey(mount: ExecutionStorageIdentity): string {
  return JSON.stringify([
    mount.orgId,
    mount.userId,
    mount.storageId,
    mount.versionId,
    mount.name,
  ]);
}

function validateRequests(mounts: readonly ExecutionStorageRequest[]): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (
      !mount.orgId ||
      !mount.userId ||
      !mount.storageId ||
      !mount.versionId ||
      !mount.name ||
      !mount.mountPath
    ) {
      throw new Error(
        "Execution storage requires complete owner, version and mount identities",
      );
    }
    if (paths.has(mount.mountPath)) {
      throw new Error(`Duplicate storage mount path "${mount.mountPath}"`);
    }
    paths.add(mount.mountPath);
    if (mount.mode === "writeback") {
      if (mount.orgId === SYSTEM_ORG_ID) {
        throw new Error("System storage cannot be mounted for writeback");
      }
      if (
        mount.missingRootPolicy !== "fail" &&
        mount.missingRootPolicy !== "preserveParentVersion"
      ) {
        throw new Error("Invalid writeback missing-root policy");
      }
    } else if (mount.mode !== "readonly" || "missingRootPolicy" in mount) {
      throw new Error("Invalid read-only storage mount configuration");
    }
  }
}

type VersionRow = Pick<
  typeof memoryVersions.$inferSelect,
  "archiveSize" | "fileCount"
> & {
  readonly storageId: typeof memoryVersions.$inferSelect.memoryId;
  readonly versionId: typeof memoryVersions.$inferSelect.id;
  readonly s3Key: typeof memoryVersions.$inferSelect.objectPrefix;
  readonly orgId: typeof memberMemories.$inferSelect.orgId;
  readonly userId: typeof memberMemories.$inferSelect.userId;
  readonly name: string;
};

interface ResolvedExecutionStorageInput {
  readonly mounts: readonly ExecutionStorageRequest[];
  readonly versions: readonly VersionRow[];
  readonly cacheRows: ExecutionStorageCacheRows;
}

function acceptedStorageRequests(
  mounts: readonly PersistedStorageMount[],
): readonly ExecutionStorageRequest[] {
  return mounts.map((mount): ExecutionStorageRequest => {
    if (!isMemberMemoryIdentity(mount)) {
      throw new Error("Accepted Run mount is not member Memory");
    }
    if (!mount.version) {
      throw new Error("Accepted storage mount is missing its exact version");
    }
    const identity = {
      orgId: mount.orgId,
      userId: mount.userId,
      storageId: mount.storageId,
      versionId: mount.version,
      name: mount.name,
      mountPath: mount.mountPath,
    };
    return mount.writeback
      ? {
          ...identity,
          mode: "writeback",
          missingRootPolicy: mount.missingRootPolicy ?? "fail",
        }
      : { ...identity, mode: "readonly" };
  });
}

/** Resolve the exact Memory versions captured at Run admission. */
export function createAcceptedExecutionStorageObjects(
  mounts$: Computed<Promise<readonly PersistedStorageMount[]>>,
): ExecutionStorageObjects {
  const input$ = computed(
    async (get): Promise<ResolvedExecutionStorageInput> => {
      const mounts = acceptedStorageRequests(await get(mounts$));
      validateRequests(mounts);
      if (mounts.length === 0) {
        return { mounts, versions: [], cacheRows: [] };
      }
      const unique = new Map(
        mounts.map((mount) => {
          return [mountKey(mount), mount];
        }),
      );
      const db = get(db$);
      const memoryCacheKey = storageVersionCacheKeySql({
        orgId: sql`${memberMemories.orgId}`,
        versionId: sql`${memoryVersions.id}`,
        s3Key: sql`${memoryVersions.objectPrefix}`,
      });
      const rows = await db
        .select({
          storageId: memoryVersions.memoryId,
          versionId: memoryVersions.id,
          s3Key: memoryVersions.objectPrefix,
          archiveSize: memoryVersions.archiveSize,
          fileCount: memoryVersions.fileCount,
          orgId: memberMemories.orgId,
          userId: memberMemories.userId,
          name: sql`${MEMORY_ARTIFACT_NAME}`.mapWith(memberMemories.userId),
          cacheKey: systemStoragePresignedUrlCache.cacheKey,
          cacheScope: systemStoragePresignedUrlCache.scope,
          presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
        })
        .from(memoryVersions)
        .innerJoin(
          memberMemories,
          eq(memberMemories.id, memoryVersions.memoryId),
        )
        .leftJoin(
          systemStoragePresignedUrlCache,
          eq(systemStoragePresignedUrlCache.cacheKey, memoryCacheKey),
        )
        .where(
          or(
            ...[...unique.values()].map((mount) => {
              return and(
                eq(memoryVersions.id, mount.versionId),
                eq(memberMemories.id, mount.storageId),
                eq(memberMemories.orgId, mount.orgId),
                eq(memberMemories.userId, mount.userId),
              );
            }),
          ),
        );
      const found = new Set(
        rows.map((row) => {
          return mountKey({ ...row, mountPath: "" });
        }),
      );
      if (
        [...unique.keys()].some((key) => {
          return !found.has(key);
        })
      ) {
        // Selected versions can be removed by their owner after Run admission.
        throw new Error("Accepted execution storage is unavailable");
      }
      return {
        mounts,
        versions: rows,
        cacheRows: rows.flatMap(cacheRowsFromProjection),
      };
    },
  );
  return createExecutionStorageObjects(input$);
}

function cacheRequest(
  mount: ExecutionStorageRequest,
  version: VersionRow,
  bucket: string,
) {
  const request = {
    bucket,
    objectKey: `${version.s3Key}/archive.tar.gz`,
    storageVersionId: version.versionId,
    resolvedOrgId: version.orgId,
    publicEndpoint: true,
  };
  if (mount.orgId === SYSTEM_ORG_ID) {
    return {
      scope: "system_storage" as const,
      request,
      key: systemStoragePresignedUrlCacheKey(request),
    };
  }
  return {
    scope: "readonly_storage" as const,
    request,
    key: readOnlyStoragePresignedUrlCacheKey(request),
  };
}

function signingRequests(
  mounts: readonly ExecutionStorageRequest[],
  rows: readonly VersionRow[],
  bucket: string,
) {
  const versions = new Map(
    rows.map((row) => {
      return [mountKey({ ...row, mountPath: "" }), row];
    }),
  );
  const selected = mounts.map((mount) => {
    const version = versions.get(mountKey(mount));
    if (!version) {
      throw new Error("Validated storage version is missing");
    }
    return {
      mount,
      version,
      cache:
        mount.mode === "writeback" && version.fileCount === 0
          ? undefined
          : cacheRequest(mount, version, bucket),
    };
  });
  const input: CacheInput = {
    systemRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "system_storage" ? [cache.request] : [];
    }),
    readOnlyRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "readonly_storage" ? [cache.request] : [];
    }),
  };
  return { selected, input };
}

function preparedMounts(
  requests: ReturnType<typeof signingRequests>,
  signed: Awaited<ReturnType<typeof signStorageManifestPresignedUrls>>,
): readonly PreparedExecutionStorageMount[] {
  const freshByKey = new Map(
    signed.freshValues.map((value) => {
      return [value.cacheKey, value];
    }),
  );
  return requests.selected.map(
    ({ mount, version, cache }): PreparedExecutionStorageMount => {
      const identity = {
        orgId: mount.orgId,
        userId: mount.userId,
        storageId: mount.storageId,
        versionId: mount.versionId,
        name: mount.name,
        mountPath: mount.mountPath,
      };
      if (mount.mode === "writeback" && version.fileCount === 0) {
        return {
          ...identity,
          writeback: true,
          empty: true,
          missingRootPolicy: mount.missingRootPolicy,
        };
      }
      const archiveUrl = cache ? signed.results.get(cache.key)?.url : undefined;
      if (!archiveUrl || !cache) {
        throw new Error("Prepared storage URL is missing");
      }
      const fresh = freshByKey.get(cache.key);
      const cacheWrite = fresh ? { presignedUrlCacheWrite: fresh } : {};
      if (mount.mode === "writeback") {
        return {
          ...identity,
          writeback: true,
          empty: false,
          archiveUrl,
          archiveSize: version.archiveSize,
          missingRootPolicy: mount.missingRootPolicy,
          ...cacheWrite,
        };
      }
      return {
        ...identity,
        writeback: false,
        archiveUrl,
        archiveSize: version.archiveSize,
        ...cacheWrite,
      };
    },
  );
}

function createExecutionStorageObjects(
  input$: Computed<Promise<ResolvedExecutionStorageInput>>,
): ExecutionStorageObjects {
  const requests$ = computed(async (get) => {
    const { mounts, versions } = await get(input$);
    return signingRequests(
      mounts,
      versions,
      env("R2_USER_STORAGES_BUCKET_NAME"),
    );
  });
  const cacheRows$ = computed(async (get): Promise<CacheSnapshot> => {
    const { cacheRows } = await get(input$);
    return cacheSnapshot(cacheRows);
  });
  const signed$ = computed(async (get) => {
    const [requests, rows] = await Promise.all([
      get(requests$),
      get(cacheRows$),
    ]);
    return await signStorageManifestPresignedUrls({
      input: requests.input,
      prefetchedRows: rows,
      sign: get(publicPresignedGetUrlSigner$),
    });
  });
  const preparedMounts$ = computed(async (get) => {
    if ((await get(input$)).mounts.length === 0) {
      return [];
    }
    const [requests, signed] = await Promise.all([
      get(requests$),
      get(signed$),
    ]);
    return preparedMounts(requests, signed);
  });
  return { preparedMounts$ };
}

function cacheSnapshot(rows: ExecutionStorageCacheRows): CacheSnapshot {
  const rowsByScope = new Map<
    StorageManifestPresignedUrlCacheScope,
    Map<string, SelectedStoragePresignedUrlCacheRow>
  >();
  for (const row of rows) {
    let scoped = rowsByScope.get(row.scope);
    if (!scoped) {
      scoped = new Map();
      rowsByScope.set(row.scope, scoped);
    }
    scoped.set(row.cacheKey, row);
  }
  return { rowsByScope };
}
