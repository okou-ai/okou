import {
  testSystemStoragePresignedUrlCacheStateContract,
  type TestSystemStoragePresignedUrlCacheStateActionBody,
} from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  systemStoragePresignedUrlCacheKey,
  pruneStoragePresignedUrls$,
} from "../services/system-storage-presigned-url-cache.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testSystemStoragePresignedUrlCacheStateContract.action,
);

type CacheStateAction<
  TAction extends TestSystemStoragePresignedUrlCacheStateActionBody["action"],
> = Extract<
  TestSystemStoragePresignedUrlCacheStateActionBody,
  { action: TAction }
>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function escapedLikePrefix(value: string): string {
  return `${value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)}%`;
}

function objectKeyPrefixCondition(prefix: string) {
  return and(
    eq(systemStoragePresignedUrlCache.scope, "system_storage"),
    sql`${like(systemStoragePresignedUrlCache.objectKey, escapedLikePrefix(prefix))} escape '\\'`,
  );
}

function storageIdentityCondition(body: {
  readonly org_id: string;
  readonly user_id: string;
  readonly storage_name: string;
}) {
  return and(
    eq(storages.orgId, body.org_id),
    eq(storages.userId, body.user_id),
    eq(storages.name, body.storage_name),
  );
}

async function cleanupForAction(
  db: Db,
  body: CacheStateAction<"cleanup">,
  signal: AbortSignal,
) {
  await db
    .delete(systemStoragePresignedUrlCache)
    .where(objectKeyPrefixCondition(body.object_key_prefix));
  signal.throwIfAborted();
  return actionOk();
}

async function claimOwnedStoragesForAction(
  db: Db,
  body: CacheStateAction<"claim-owned-storages">,
  signal: AbortSignal,
) {
  await db.insert(storages).values(
    body.storages.map((storage) => {
      return {
        id: storage.storage_id,
        orgId: storage.org_id,
        userId: storage.user_id,
        name: storage.storage_name,
        s3Prefix: storage.s3_prefix,
        size: 0,
        fileCount: 0,
      };
    }),
  );
  signal.throwIfAborted();
  return actionOk();
}

async function cleanupOwnedStoragesForAction(
  db: Db,
  body: CacheStateAction<"cleanup-owned-storages">,
  signal: AbortSignal,
) {
  await db.delete(storages).where(inArray(storages.id, body.storage_ids));
  signal.throwIfAborted();
  return actionOk();
}

async function readOwnedStorageStateForAction(
  db: Db,
  body: CacheStateAction<"read-owned-storage-state">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({
      s3Prefix: storages.s3Prefix,
      size: storages.size,
      fileCount: storages.fileCount,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(eq(storages.id, body.storage_id))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage_state: storage
      ? {
          s3_prefix: storage.s3Prefix,
          size: storage.size,
          file_count: storage.fileCount,
          head_version_id: storage.headVersionId,
        }
      : null,
  });
}

async function seedOwnedStorageVersionForAction(
  db: Db,
  body: CacheStateAction<"seed-owned-storage-version">,
  signal: AbortSignal,
) {
  await db.insert(storageVersions).values({
    id: body.version_id,
    storageId: body.storage_id,
    s3Key: body.s3_key,
    size: 1,
    archiveSize: body.archive_size,
    fileCount: 1,
    message: "Seeded by owned system storage route test fixture",
    createdBy: "test",
  });
  signal.throwIfAborted();

  const updated = await db
    .update(storages)
    .set({
      size: 1,
      fileCount: 1,
      headVersionId: body.version_id,
    })
    .where(eq(storages.id, body.storage_id))
    .returning({ id: storages.id });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Owned storage is unavailable");
  }
  return actionOk();
}

async function requireOwnedSystemStorage(
  db: Db,
  storageId: string,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.id, storageId),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Owned system storage is unavailable");
  }
  return storage;
}

async function requireOwnedSystemStorageVersion(
  db: Db,
  storageId: string,
  versionId: string,
  signal: AbortSignal,
) {
  const [version] = await db
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storages.id, storageId),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storageVersions.id, versionId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!version) {
    throw new Error("Owned system storage version is unavailable");
  }
  return version;
}

async function cleanupOwnedStorageCacheForAction(
  db: Db,
  body: CacheStateAction<"cleanup-owned-storage-cache">,
  signal: AbortSignal,
) {
  const storage = await requireOwnedSystemStorage(db, body.storage_id, signal);
  await db
    .delete(systemStoragePresignedUrlCache)
    .where(objectKeyPrefixCondition(`${storage.s3Prefix}/`));
  signal.throwIfAborted();
  return actionOk();
}

async function seedOwnedStorageCacheRowForAction(
  db: Db,
  body: CacheStateAction<"seed-owned-storage-cache-row">,
  signal: AbortSignal,
) {
  const version = await requireOwnedSystemStorageVersion(
    db,
    body.storage_id,
    body.storage_version_id,
    signal,
  );
  const objectKey = `${version.s3Key}/archive.tar.gz`;
  await db
    .insert(systemStoragePresignedUrlCache)
    .values({
      cacheKey: systemStoragePresignedUrlCacheKey({
        bucket: body.bucket,
        objectKey,
        storageVersionId: body.storage_version_id,
        publicEndpoint: body.public_endpoint,
      }),
      scope: "system_storage",
      bucket: body.bucket,
      objectKey,
      storageVersionId: body.storage_version_id,
      resolvedOrgId: null,
      publicEndpoint: body.public_endpoint,
      ttlSeconds: body.ttl_seconds,
      presignedUrl: body.presigned_url,
      expiresAt: new Date(body.expires_at),
      refreshAfter: new Date(body.refresh_after),
      lastRequestedAt: new Date(body.last_requested_at ?? body.refresh_after),
      updatedAt: new Date(body.refresh_after),
    })
    .onConflictDoUpdate({
      target: systemStoragePresignedUrlCache.cacheKey,
      set: {
        scope: sql`excluded.scope`,
        bucket: sql`excluded.bucket`,
        objectKey: sql`excluded.object_key`,
        storageVersionId: sql`excluded.storage_version_id`,
        resolvedOrgId: sql`excluded.resolved_org_id`,
        publicEndpoint: sql`excluded.public_endpoint`,
        ttlSeconds: sql`excluded.ttl_seconds`,
        presignedUrl: sql`excluded.presigned_url`,
        expiresAt: sql`excluded.expires_at`,
        refreshAfter: sql`excluded.refresh_after`,
        lastRequestedAt: sql`excluded.last_requested_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function readOwnedStorageCacheForAction(
  db: Db,
  body: CacheStateAction<"read-owned-storage-cache">,
  signal: AbortSignal,
) {
  const storage = await requireOwnedSystemStorage(db, body.storage_id, signal);
  return await readCacheByObjectKeyPrefix(db, `${storage.s3Prefix}/`, signal);
}

async function readStorageStateForAction(
  db: Db,
  body: CacheStateAction<"read-storage-state">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({
      s3Prefix: storages.s3Prefix,
      size: storages.size,
      fileCount: storages.fileCount,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(storageIdentityCondition(body))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage_state: storage
      ? {
          s3_prefix: storage.s3Prefix,
          size: storage.size,
          file_count: storage.fileCount,
          head_version_id: storage.headVersionId,
        }
      : null,
  });
}

async function readStorageVersionForAction(
  db: Db,
  body: CacheStateAction<"read-storage-version">,
  signal: AbortSignal,
) {
  const [version] = await db
    .select({
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        storageIdentityCondition(body),
        eq(storageVersions.id, body.version_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage_version: version
      ? {
          version_id: version.versionId,
          s3_key: version.s3Key,
          size: version.size,
          archive_size: version.archiveSize,
          file_count: version.fileCount,
          message: version.message,
          created_by: version.createdBy,
        }
      : null,
  });
}

async function setStorageVersionArchiveSizeForAction(
  db: Db,
  body: CacheStateAction<"set-storage-version-archive-size">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({ id: storages.id })
    .from(storages)
    .where(storageIdentityCondition(body))
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Storage is unavailable");
  }

  const updated = await db
    .update(storageVersions)
    .set({ archiveSize: body.archive_size })
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, body.version_id),
      ),
    )
    .returning({ id: storageVersions.id });
  signal.throwIfAborted();
  if (updated.length === 0) {
    throw new Error("Storage version is unavailable");
  }
  return actionOk();
}

async function readCacheByObjectKeyPrefix(
  db: Db,
  objectKeyPrefix: string,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      bucket: systemStoragePresignedUrlCache.bucket,
      objectKey: systemStoragePresignedUrlCache.objectKey,
      storageVersionId: systemStoragePresignedUrlCache.storageVersionId,
      publicEndpoint: systemStoragePresignedUrlCache.publicEndpoint,
      ttlSeconds: systemStoragePresignedUrlCache.ttlSeconds,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
      refreshAfter: systemStoragePresignedUrlCache.refreshAfter,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(objectKeyPrefixCondition(objectKeyPrefix));
  signal.throwIfAborted();
  return actionOk({
    rows: rows.map((row) => {
      return {
        cache_key: row.cacheKey,
        bucket: row.bucket,
        object_key: row.objectKey,
        storage_version_id: row.storageVersionId,
        public_endpoint: row.publicEndpoint,
        ttl_seconds: row.ttlSeconds,
        presigned_url: row.presignedUrl,
        expires_at: row.expiresAt.toISOString(),
        refresh_after: row.refreshAfter.toISOString(),
        last_requested_at: row.lastRequestedAt.toISOString(),
      };
    }),
  });
}

async function readCacheByObjectKeyPrefixForAction(
  db: Db,
  body: CacheStateAction<"read-cache-by-object-key-prefix">,
  signal: AbortSignal,
) {
  return await readCacheByObjectKeyPrefix(db, body.object_key_prefix, signal);
}

const mutateSystemStoragePresignedUrlCacheState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "cleanup": {
        return await cleanupForAction(db, body, signal);
      }
      case "claim-owned-storages": {
        return await claimOwnedStoragesForAction(db, body, signal);
      }
      case "cleanup-owned-storages": {
        return await cleanupOwnedStoragesForAction(db, body, signal);
      }
      case "read-owned-storage-state": {
        return await readOwnedStorageStateForAction(db, body, signal);
      }
      case "seed-owned-storage-version": {
        return await seedOwnedStorageVersionForAction(db, body, signal);
      }
      case "cleanup-owned-storage-cache": {
        return await cleanupOwnedStorageCacheForAction(db, body, signal);
      }
      case "seed-owned-storage-cache-row": {
        return await seedOwnedStorageCacheRowForAction(db, body, signal);
      }
      case "read-owned-storage-cache": {
        return await readOwnedStorageCacheForAction(db, body, signal);
      }
      case "prune-owned-storage-cache": {
        const storage = await requireOwnedSystemStorage(
          db,
          body.storage_id,
          signal,
        );
        const result = await set(
          pruneStoragePresignedUrls$,
          {
            db,
            scope: "system_storage",
            limit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
            objectKeyPrefix: `${storage.s3Prefix}/`,
          },
          signal,
        );
        signal.throwIfAborted();
        return actionOk({ cache_prune: result });
      }
      case "read-storage-state": {
        return await readStorageStateForAction(db, body, signal);
      }
      case "read-storage-version": {
        return await readStorageVersionForAction(db, body, signal);
      }
      case "set-storage-version-archive-size": {
        return await setStorageVersionArchiveSizeForAction(db, body, signal);
      }
      case "read-cache-by-object-key-prefix": {
        return await readCacheByObjectKeyPrefixForAction(db, body, signal);
      }
    }
  },
);

export const testSystemStoragePresignedUrlCacheStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testSystemStoragePresignedUrlCacheStateContract.action,
      handler: mutateSystemStoragePresignedUrlCacheState$,
    },
  ];
