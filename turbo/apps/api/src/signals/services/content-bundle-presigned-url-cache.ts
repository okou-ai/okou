import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { contentBundleKey } from "@okouai/core/content-bundle";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { computed } from "ccstate";
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { number, object, string, type output } from "zod";
import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { nowDate, nowDateSql } from "../../lib/time";
import { STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS } from "./system-storage-presigned-url-cache.service";

const CACHE_SCOPE = "content_bundle" as const;
const RECENT_URL_LIMIT = 2048;

export interface ContentBundleUrlCacheContext {
  readonly bucket: string;
  readonly keyPrefix: string;
}

export const cachedContentBundleUrlSchema = object({
  sha256: string(),
  url: string(),
  expiresAtMs: number(),
});

type CachedContentBundleUrl = output<typeof cachedContentBundleUrlSchema>;

export interface ContentBundleUrlCacheSnapshot {
  readonly context: ContentBundleUrlCacheContext;
  readonly rows: readonly CachedContentBundleUrl[];
}

// Only completed URLs are shared across requests. Every caller must authorize
// and select its immutable bundles before consulting this map.
const recentUrlCache = singleton(() => {
  return new Map<string, CachedContentBundleUrl>();
});

export function readRememberedContentBundleUrls(
  context: ContentBundleUrlCacheContext,
  hashes: readonly string[],
) {
  const recentUrls = recentUrlCache();
  const rows: CachedContentBundleUrl[] = [];
  const remaining: string[] = [];
  const minimumExpiry =
    nowDate().getTime() + STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS;
  for (const hash of hashes) {
    const key = `${context.keyPrefix}:${hash}`;
    const row = recentUrls.get(key);
    if (row) {
      recentUrls.delete(key);
      if (row.expiresAtMs >= minimumExpiry) {
        recentUrls.set(key, row);
        rows.push(row);
        continue;
      }
    }
    remaining.push(hash);
  }
  return { rows, remaining };
}

export function rememberContentBundleUrls(
  context: ContentBundleUrlCacheContext,
  rows: ContentBundleUrlCacheSnapshot["rows"],
): void {
  const recentUrls = recentUrlCache();
  for (const row of rows) {
    const key = `${context.keyPrefix}:${row.sha256}`;
    const current = recentUrls.get(key);
    if (current && current.expiresAtMs >= row.expiresAtMs) {
      continue;
    }
    recentUrls.delete(key);
    recentUrls.set(key, row);
    if (recentUrls.size > RECENT_URL_LIMIT) {
      const oldest = recentUrls.keys().next();
      if (!oldest.done) {
        recentUrls.delete(oldest.value);
      }
    }
  }
}

export const contentBundleUrlCacheContext$ = computed(
  (): ContentBundleUrlCacheContext => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    return {
      bucket,
      keyPrefix: createHash("sha256")
        .update(
          JSON.stringify([
            "content-bundle-url-v1",
            bucket,
            // Deployment configuration is fixed for this instance.
            env("R2_ACCESS_KEY_ID"),
            env("R2_SECRET_ACCESS_KEY"),
            env("R2_ACCOUNT_ID"),
            env("S3_ENDPOINT"),
            env("S3_REGION"),
            env("S3_FORCE_PATH_STYLE"),
            "private",
            PRESIGNED_URL_TTL_SECONDS,
          ]),
        )
        .digest("hex"),
    };
  },
);

function cacheKey(
  context: ContentBundleUrlCacheContext,
  sha256: string,
): string {
  return createHash("sha256")
    .update(`${context.keyPrefix}:${sha256}`)
    .digest("hex");
}

/** Adapt immutable bundle identity to the existing signed-object cache engine. */
export function contentBundleUrlCacheRequest(
  context: ContentBundleUrlCacheContext,
  sha256: string,
) {
  return {
    cacheKey: cacheKey(context, sha256),
    request: {
      scope: CACHE_SCOPE,
      bucket: context.bucket,
      objectKey: contentBundleKey(sha256),
      storageVersionId: sha256,
      resolvedOrgId: null,
      publicEndpoint: false,
    },
    ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
  };
}

/** Read URLs for the execution's accepted immutable bundle identities. */
export function contentBundleUrlCacheSnapshotSql(
  context: ContentBundleUrlCacheContext,
  hashes: readonly string[],
): SQL {
  // Required-query failures must not expose raw package hashes in parameters.
  const keys = [...new Set(hashes)].map((hash) => {
    return cacheKey(context, hash);
  });
  return sql`(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'sha256', ${systemStoragePresignedUrlCache.storageVersionId},
      'url', ${systemStoragePresignedUrlCache.presignedUrl},
      'expiresAtMs', (EXTRACT(EPOCH FROM ${systemStoragePresignedUrlCache.expiresAt}) * 1000)::double precision
    )), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) AS cache_key
    ) AS selected_bundles
    INNER JOIN ${systemStoragePresignedUrlCache}
      ON ${eq(systemStoragePresignedUrlCache.cacheKey, sql`selected_bundles.cache_key`)}
    WHERE ${and(
      eq(systemStoragePresignedUrlCache.scope, CACHE_SCOPE),
      gte(
        systemStoragePresignedUrlCache.expiresAt,
        sql`${nowDateSql()} + ${STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS} * interval '1 millisecond'`,
      ),
    )}
  )`;
}
