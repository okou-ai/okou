import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { contentBundleKey } from "@okouai/core/content-bundle";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { command } from "ccstate";
import { and, eq, gt, gte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { number, object, string } from "zod";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { monotonicNow, nowDateSql } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { presignedGetUrlCacheIdentity$ } from "../external/s3";
import { settle } from "../utils";

const L = logger("ContentBundleUrlCache");
const CACHE_SCOPE = "content_bundle";
export const CONTENT_BUNDLE_URL_MIN_REMAINING_MS = 4 * 60 * 60 * 1000;
export const CONTENT_BUNDLE_URL_PRUNE_LIMIT = 512;

export interface ContentBundleUrlCacheContext {
  readonly bucket: string;
  readonly keyPrefix: string;
}

export const cachedContentBundleUrlSchema = object({
  sha256: string(),
  url: string(),
  expiresAtMs: number(),
});

export interface ContentBundleUrlCacheWrite {
  readonly sha256: string;
  readonly url: string;
  readonly issuedAt: Date;
}

export interface ContentBundleUrlCachePublication {
  readonly durationMs: number;
  readonly status: "skipped" | "written" | "error";
}

export const prepareContentBundleUrlCache$ = command(
  ({ set }): ContentBundleUrlCacheContext => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const signingIdentity = set(presignedGetUrlCacheIdentity$, {
      bucket,
      publicEndpoint: false,
    });
    return {
      bucket,
      keyPrefix: createHash("sha256")
        .update(
          JSON.stringify([
            "content-bundle-url-v1",
            bucket,
            signingIdentity,
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

/** Read only the successful claim's selected identities, in its atomic statement. */
export function contentBundleUrlCacheSnapshotSql(
  context: ContentBundleUrlCacheContext,
  additionalHashes: readonly string[],
): SQL {
  const instructionsKey = sql`encode(sha256(convert_to(${context.keyPrefix} || ':' || ("instructionsBundle"->>'sha256'), 'UTF8')), 'hex')`;
  const workflowKey = sql`encode(sha256(convert_to(${context.keyPrefix} || ':' || ("contentBundle"->>'sha256'), 'UTF8')), 'hex')`;
  // Required-query failures must not expose raw package hashes in parameters.
  const additionalKeys = [...new Set(additionalHashes)].map((hash) => {
    return cacheKey(context, hash);
  });
  return sql`(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'sha256', ${systemStoragePresignedUrlCache.storageVersionId},
      'url', ${systemStoragePresignedUrlCache.presignedUrl},
      'expiresAtMs', (EXTRACT(EPOCH FROM ${systemStoragePresignedUrlCache.expiresAt}) * 1000)::double precision
    )), '[]'::jsonb)
    FROM (
      SELECT ${instructionsKey} AS cache_key FROM selected_agent
      UNION
      SELECT ${workflowKey} FROM selected_workflows
      UNION
      SELECT jsonb_array_elements_text(${JSON.stringify(additionalKeys)}::jsonb)
    ) AS selected_bundles
    INNER JOIN ${systemStoragePresignedUrlCache}
      ON ${eq(systemStoragePresignedUrlCache.cacheKey, sql`selected_bundles.cache_key`)}
    WHERE ${and(
      eq(systemStoragePresignedUrlCache.scope, CACHE_SCOPE),
      gte(
        systemStoragePresignedUrlCache.expiresAt,
        sql`${nowDateSql()} + ${CONTENT_BUNDLE_URL_MIN_REMAINING_MS} * interval '1 millisecond'`,
      ),
    )}
  )`;
}

/** Disposable publication never changes the already-signed response's authority. */
export const persistContentBundleUrls$ = command(
  async (
    { set },
    context: ContentBundleUrlCacheContext,
    writes: readonly ContentBundleUrlCacheWrite[],
    signal: AbortSignal,
  ): Promise<ContentBundleUrlCachePublication> => {
    signal.throwIfAborted();
    const startedAt = monotonicNow();
    if (writes.length === 0) {
      return { durationMs: monotonicNow() - startedAt, status: "skipped" };
    }
    const values = writes
      .map((write) => {
        return {
          cacheKey: cacheKey(context, write.sha256),
          scope: CACHE_SCOPE,
          bucket: context.bucket,
          objectKey: contentBundleKey(write.sha256),
          // This shared cache column is historical; no Storage entity is involved.
          storageVersionId: write.sha256,
          resolvedOrgId: null,
          publicEndpoint: false,
          ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
          presignedUrl: write.url,
          expiresAt: new Date(
            write.issuedAt.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
          ),
          lastRequestedAt: write.issuedAt,
          updatedAt: write.issuedAt,
        };
      })
      .sort((left, right) => {
        return left.cacheKey.localeCompare(right.cacheKey);
      });
    const excluded = alias(systemStoragePresignedUrlCache, "excluded");
    const result = await settle(
      set(writeDb$)
        .insert(systemStoragePresignedUrlCache)
        .values(values)
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: {
            presignedUrl: excluded.presignedUrl,
            expiresAt: excluded.expiresAt,
            lastRequestedAt: excluded.lastRequestedAt,
            updatedAt: excluded.updatedAt,
          },
          setWhere: gt(
            excluded.expiresAt,
            systemStoragePresignedUrlCache.expiresAt,
          ),
        }),
      signal,
    );
    if (!result.ok) {
      // A driver error can contain SQL parameters, including the signed URLs.
      L.warn("Content Bundle URL cache publication failed", {
        cacheEntryCount: values.length,
      });
    }
    return {
      durationMs: monotonicNow() - startedAt,
      status: result.ok ? "written" : "error",
    };
  },
);
