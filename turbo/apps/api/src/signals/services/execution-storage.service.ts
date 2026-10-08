import { computed, command, type Computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import {
  readExecutionStorageCacheRows,
  type ExecutionStorageCacheRows,
} from "./execution-storage-cache-read.service";
import { alias } from "drizzle-orm/pg-core";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { publicPresignedGetUrlSigner$ } from "../external/s3";
import { settle } from "../utils";
import {
  signStorageManifestPresignedUrls,
  storageManifestPresignedUrlCacheLookupPairs,
  systemStoragePresignedUrlCacheKey,
  workflowSkillStoragePresignedUrlCacheKey,
  readOnlyStoragePresignedUrlCacheKey,
  type StorageManifestPresignedUrlCacheScope,
  type SelectedStoragePresignedUrlCacheRow,
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
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
}

export interface WritebackStorageRequest extends ExecutionStorageIdentity {
  readonly mode: "writeback";
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export type ExecutionStorageRequest =
  | ReadOnlyStorageRequest
  | WritebackStorageRequest;
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
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
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
const log = logger("ExecutionStorage");

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
      if (
        "baselineCandidate" in mount ||
        "instructionsTargetFilename" in mount
      ) {
        throw new Error("Read-only mount options cannot be used for writeback");
      }
    } else if (mount.mode !== "readonly" || "missingRootPolicy" in mount) {
      throw new Error("Invalid read-only storage mount configuration");
    }
  }
}

async function readExactVersions(
  db: Pick<ReadonlyDb, "select">,
  mounts: readonly ExecutionStorageRequest[],
) {
  if (mounts.length === 0) {
    return [];
  }
  const unique = [
    ...new Map(
      mounts.map((mount) => {
        return [mountKey(mount), mount];
      }),
    ).values(),
  ];
  const rows = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      storageId: storages.id,
      name: storages.name,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storages)
    .innerJoin(
      sql`unnest(
    ${sql.param(
      unique.map((mount) => {
        return mount.orgId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((mount) => {
        return mount.userId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((mount) => {
        return mount.storageId;
      }),
    )}::uuid[],
    ${sql.param(
      unique.map((mount) => {
        return mount.versionId;
      }),
    )}::varchar(64)[],
    ${sql.param(
      unique.map((mount) => {
        return mount.name;
      }),
    )}::varchar(256)[]
  ) AS requested(org_id, user_id, storage_id, version_id, name)`,
      and(
        eq(storages.orgId, sql`requested.org_id`),
        eq(storages.userId, sql`requested.user_id`),
        eq(storages.id, sql`requested.storage_id`),
        eq(storages.name, sql`requested.name`),
      ),
    )
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, sql`requested.version_id`),
      ),
    );
  const found = new Map(
    rows.map((row) => {
      return [mountKey({ ...row, mountPath: "" }), row];
    }),
  );
  for (const mount of unique) {
    const row = found.get(mountKey(mount));
    if (!row) {
      throw new Error(
        `Requested storage version is unavailable: ${mount.storageId}/${mount.versionId}`,
      );
    }
    if (
      !Number.isSafeInteger(row.archiveSize) ||
      row.archiveSize < 0 ||
      !Number.isSafeInteger(row.fileCount) ||
      row.fileCount < 0 ||
      !row.s3Key
    ) {
      throw new Error("Invalid persisted execution storage version");
    }
  }
  return rows;
}

type VersionRow = Awaited<ReturnType<typeof readExactVersions>>[number];

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
  // These are storage/cache namespaces, not Thread/workflow selection policy.
  if (mount.orgId === SYSTEM_ORG_ID) {
    return {
      scope: "system_storage" as const,
      request,
      key: systemStoragePresignedUrlCacheKey(request),
    };
  }
  if (
    mount.mode === "readonly" &&
    mount.userId === VOLUME_ORG_USER_ID &&
    mount.name.startsWith(getCustomSkillStorageName(""))
  ) {
    return {
      scope: "workflow_skill_storage" as const,
      request,
      key: workflowSkillStoragePresignedUrlCacheKey(request),
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
    workflowSkillRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "workflow_skill_storage" ? [cache.request] : [];
    }),
    readOnlyRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "readonly_storage" ? [cache.request] : [];
    }),
    logicalLookupCount: new Set(
      selected.flatMap(({ cache }) => {
        return cache ? [cache.scope] : [];
      }),
    ).size,
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
        ...(mount.baselineCandidate
          ? { baselineCandidate: mount.baselineCandidate }
          : {}),
        ...(mount.instructionsTargetFilename === undefined
          ? {}
          : { instructionsTargetFilename: mount.instructionsTargetFilename }),
        ...cacheWrite,
      };
    },
  );
}

/** Cache persistence is an explicit log-only exception, owned after commit. */
const persistPresignedUrlCache$ = command(
  async (
    { set },
    values: FreshCacheValues,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const unique = [
      ...new Map(
        values.map((value) => {
          return [value.cacheKey, value];
        }),
      ).values(),
    ].sort((a, b) => {
      return a.cacheKey.localeCompare(b.cacheKey);
    });
    if (unique.length === 0) {
      return;
    }
    const excluded = alias(systemStoragePresignedUrlCache, "excluded");
    const result = await settle(
      set(writeDb$)
        .insert(systemStoragePresignedUrlCache)
        .values(unique)
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: {
            scope: excluded.scope,
            bucket: excluded.bucket,
            objectKey: excluded.objectKey,
            storageVersionId: excluded.storageVersionId,
            resolvedOrgId: excluded.resolvedOrgId,
            publicEndpoint: excluded.publicEndpoint,
            ttlSeconds: excluded.ttlSeconds,
            presignedUrl: excluded.presignedUrl,
            expiresAt: excluded.expiresAt,
            refreshAfter: excluded.refreshAfter,
            lastRequestedAt: excluded.lastRequestedAt,
            updatedAt: excluded.updatedAt,
          },
        }),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      log.error("Failed to update execution storage presigned URL cache", {
        cacheEntryCount: unique.length,
        error: result.error,
      });
    }
  },
);

export function executionStorageCachePairs(
  mounts: readonly ExecutionStorageRequest[],
  versions: Awaited<ReturnType<typeof readExactVersions>>,
): {
  readonly pairs: readonly {
    readonly scope: StorageManifestPresignedUrlCacheScope;
    readonly cacheKey: string;
  }[];
} {
  return storageManifestPresignedUrlCacheLookupPairs(
    signingRequests(mounts, versions, env("R2_USER_STORAGES_BUCKET_NAME"))
      .input,
    false,
  );
}

/** Exact identity reads and local signing only; no HEAD selection or storage initialization. */
export function createExecutionStorageObjects(
  mounts: readonly ExecutionStorageRequest[],
): ExecutionStorageObjects {
  return createStorageObjects(mounts, { kind: "read" });
}

/** The canonical Thread already resolved exact rows; never reread those identities. */
export function createResolvedExecutionStorageObjects(
  mounts: readonly ExecutionStorageRequest[],
  versions: Awaited<ReturnType<typeof readExactVersions>>,
  cacheRows: ExecutionStorageCacheRows,
): ExecutionStorageObjects {
  return createStorageObjects(
    mounts,
    { kind: "captured", versions },
    cacheRows,
  );
}

function createStorageObjects(
  mounts: readonly ExecutionStorageRequest[],
  input:
    | { readonly kind: "read" }
    | {
        readonly kind: "captured";
        readonly versions: Awaited<ReturnType<typeof readExactVersions>>;
      },
  suppliedCacheRows?: ExecutionStorageCacheRows,
): ExecutionStorageObjects {
  const versions$ = computed(async (get) => {
    validateRequests(mounts);
    return input.kind === "captured"
      ? input.versions
      : await readExactVersions(get(db$), mounts);
  });
  const requests$ = computed(async (get) => {
    return signingRequests(
      mounts,
      await get(versions$),
      env("R2_USER_STORAGES_BUCKET_NAME"),
    );
  });
  const cacheRows$ = computed(async (get): Promise<CacheSnapshot> => {
    const { input } = await get(requests$);
    const { pairs, cacheKeysByRequest } =
      storageManifestPresignedUrlCacheLookupPairs(input, false);
    const rows =
      suppliedCacheRows === undefined
        ? await readExecutionStorageCacheRows(get(db$), pairs)
        : suppliedCacheRows;
    const rowsByScope = new Map<
      StorageManifestPresignedUrlCacheScope,
      Map<string, SelectedStoragePresignedUrlCacheRow>
    >();
    for (const row of rows) {
      if (
        row.scope !== "system_storage" &&
        row.scope !== "workflow_skill_storage" &&
        row.scope !== "readonly_storage"
      ) {
        throw new Error("Unexpected execution storage cache scope");
      }
      let scoped = rowsByScope.get(row.scope);
      if (!scoped) {
        scoped = new Map();
        rowsByScope.set(row.scope, scoped);
      }
      scoped.set(row.cacheKey, row);
    }
    return { rowsByScope, cacheKeysByRequest };
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
    if (mounts.length === 0) {
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

/**
 * The approved log-only exception, run by the owner after its commit: stores
 * the URLs a preparation of `mounts` signed fresh, so later executions reuse
 * them. A failed write is logged and never fails the committed run.
 */
export const updateExecutionStoragePresignedUrlCache$ = command(
  async (
    { set },
    mounts: readonly ExecutionStorageRequest[],
    prepared: readonly PreparedExecutionStorageMount[],
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (mounts.length === 0) {
      return;
    }
    const values = prepared.flatMap((mount) => {
      return "presignedUrlCacheWrite" in mount && mount.presignedUrlCacheWrite
        ? [mount.presignedUrlCacheWrite]
        : [];
    });
    await set(persistPresignedUrlCache$, values, signal);
  },
);
