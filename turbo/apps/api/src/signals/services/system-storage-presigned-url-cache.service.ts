import { createHash } from "node:crypto";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { joinAll } from "../utils";
import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

type StoragePresignedUrlCacheScope =
  | "system_storage"
  | "workflow_skill_storage"
  | "readonly_storage"
  | "presentation_template_preview";

export const SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS =
  PRESIGNED_URL_TTL_SECONDS;
const SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY = "system-storage-url-v1";
export const SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 100;

export const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS =
  PRESIGNED_URL_TTL_SECONDS;
const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_CACHE_POLICY =
  "workflow-skill-storage-url-v1";
export const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 100;
export const READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS =
  PRESIGNED_URL_TTL_SECONDS;
const READ_ONLY_STORAGE_PRESIGNED_URL_CACHE_POLICY = "readonly-storage-url-v1";
export const READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 256;
const PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_CACHE_POLICY =
  "presentation-template-preview-url-v1";
export const PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT = 512;
const deletedCacheRowSchema = z.object({ cacheKey: z.string() });

type StoragePresignedUrlCacheStatus = "hit" | "miss";

export type SystemStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;
export type WorkflowSkillStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;
export type ReadOnlyStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;

export interface SystemStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly publicEndpoint: boolean;
}

export interface WorkflowSkillStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string;
  readonly publicEndpoint: boolean;
}

export interface ReadOnlyStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string;
  readonly publicEndpoint: boolean;
}

export interface PresentationTemplatePreviewPresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string;
  readonly publicEndpoint: boolean;
}

interface StoragePresignedUrlRequest {
  readonly scope: StoragePresignedUrlCacheScope;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
  readonly publicEndpoint: boolean;
}

export interface StoragePresignedUrlResult {
  readonly cacheKey: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly status: StoragePresignedUrlCacheStatus;
}

interface CacheRowValue {
  readonly cacheKey: string;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
  readonly publicEndpoint: boolean;
  readonly ttlSeconds: number;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
  readonly refreshAfter: Date;
  readonly lastRequestedAt: Date;
  readonly updatedAt: Date;
}

export function systemStoragePresignedUrlCacheKey(
  request: SystemStoragePresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.publicEndpoint ? "public" : "private",
        SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

export function workflowSkillStoragePresignedUrlCacheKey(
  request: WorkflowSkillStoragePresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.resolvedOrgId,
        request.publicEndpoint ? "public" : "private",
        WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

export function readOnlyStoragePresignedUrlCacheKey(
  request: ReadOnlyStoragePresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        READ_ONLY_STORAGE_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.resolvedOrgId,
        request.publicEndpoint ? "public" : "private",
        READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

export function presentationTemplatePreviewPresignedUrlCacheKey(
  request: PresentationTemplatePreviewPresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.resolvedOrgId,
        request.publicEndpoint ? "public" : "private",
        PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

function systemStorageRequest(
  request: SystemStoragePresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "system_storage",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: null,
    publicEndpoint: request.publicEndpoint,
  };
}

function workflowSkillStorageRequest(
  request: WorkflowSkillStoragePresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "workflow_skill_storage",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: request.resolvedOrgId,
    publicEndpoint: request.publicEndpoint,
  };
}

function readOnlyStorageRequest(
  request: ReadOnlyStoragePresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "readonly_storage",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: request.resolvedOrgId,
    publicEndpoint: request.publicEndpoint,
  };
}

function presentationTemplatePreviewRequest(
  request: PresentationTemplatePreviewPresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "presentation_template_preview",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: request.resolvedOrgId,
    publicEndpoint: request.publicEndpoint,
  };
}

function expirationFromIssuedAt(issuedAt: Date, ttlSeconds: number): Date {
  return new Date(issuedAt.getTime() + ttlSeconds * 1000);
}

function escapedObjectKeyPrefix(value: string): string {
  return `${value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)}%`;
}

function objectKeyPrefixCondition(objectKeyPrefix: string | undefined) {
  return objectKeyPrefix === undefined
    ? undefined
    : sql`${like(
        systemStoragePresignedUrlCache.objectKey,
        escapedObjectKeyPrefix(objectKeyPrefix),
      )} escape '\\'`;
}

function signCacheValue(args: {
  readonly request: StoragePresignedUrlRequest;
  readonly cacheKey: string;
  readonly ttlSeconds: number;
  readonly issuedAt: Date;
  readonly lastRequestedAt: Date;
}): Computed<Promise<CacheRowValue>> {
  return computed(async (get) => {
    const presignedUrl = await get(
      generatePresignedGetUrl(
        args.request.bucket,
        args.request.objectKey,
        undefined,
        args.request.publicEndpoint,
      ),
    );
    const expiresAt = expirationFromIssuedAt(args.issuedAt, args.ttlSeconds);
    return {
      cacheKey: args.cacheKey,
      scope: args.request.scope,
      bucket: args.request.bucket,
      objectKey: args.request.objectKey,
      storageVersionId: args.request.storageVersionId,
      resolvedOrgId: args.request.resolvedOrgId,
      publicEndpoint: args.request.publicEndpoint,
      ttlSeconds: args.ttlSeconds,
      presignedUrl,
      expiresAt,
      // Retain the required legacy column while older API deployments coexist.
      refreshAfter: expiresAt,
      lastRequestedAt: args.lastRequestedAt,
      updatedAt: args.issuedAt,
    };
  });
}

async function upsertCacheValues(
  db: Db,
  values: readonly CacheRowValue[],
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  const orderedValues = [...values].sort((left, right) => {
    return left.cacheKey.localeCompare(right.cacheKey);
  });
  const set = {
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
  };
  await db
    .insert(systemStoragePresignedUrlCache)
    .values(
      orderedValues.map((value) => {
        return {
          cacheKey: value.cacheKey,
          scope: value.scope,
          bucket: value.bucket,
          objectKey: value.objectKey,
          storageVersionId: value.storageVersionId,
          resolvedOrgId: value.resolvedOrgId,
          publicEndpoint: value.publicEndpoint,
          ttlSeconds: value.ttlSeconds,
          presignedUrl: value.presignedUrl,
          expiresAt: value.expiresAt,
          refreshAfter: value.refreshAfter,
          lastRequestedAt: value.lastRequestedAt,
          updatedAt: value.updatedAt,
        };
      }),
    )
    .onConflictDoUpdate({
      target: systemStoragePresignedUrlCache.cacheKey,
      set,
    });
}

async function pruneExpiredCacheRows(
  args: {
    readonly db: Db;
    readonly scope: StoragePresignedUrlCacheScope;
    readonly issuedAt: Date;
    readonly limit: number;
    readonly objectKeyPrefix: string | undefined;
  },
  signal?: AbortSignal,
): Promise<number> {
  const issuedAtTimestamp = timestampWithoutTimeZone(args.issuedAt);
  const deletedRows = await executeRawRows(
    args.db,
    sql`
      WITH candidates AS (
      SELECT ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
      FROM ${systemStoragePresignedUrlCache}
      WHERE ${and(
        eq(systemStoragePresignedUrlCache.scope, args.scope),
        lte(
          systemStoragePresignedUrlCache.expiresAt,
          sql`${issuedAtTimestamp}::timestamp`,
        ),
        objectKeyPrefixCondition(args.objectKeyPrefix),
      )}
      ORDER BY
        ${systemStoragePresignedUrlCache.expiresAt},
        ${systemStoragePresignedUrlCache.cacheKey}
      LIMIT ${args.limit}
    ),
    locked AS (
      SELECT ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
      FROM ${systemStoragePresignedUrlCache}
      INNER JOIN candidates
        ON ${eq(
          systemStoragePresignedUrlCache.cacheKey,
          sql`candidates."cacheKey"`,
        )}
      WHERE ${and(
        eq(systemStoragePresignedUrlCache.scope, args.scope),
        lte(
          systemStoragePresignedUrlCache.expiresAt,
          sql`${issuedAtTimestamp}::timestamp`,
        ),
        objectKeyPrefixCondition(args.objectKeyPrefix),
      )}
      ORDER BY ${systemStoragePresignedUrlCache.cacheKey}
      FOR UPDATE OF ${systemStoragePresignedUrlCache}
    )
    DELETE FROM ${systemStoragePresignedUrlCache}
    USING locked
    WHERE ${eq(systemStoragePresignedUrlCache.cacheKey, sql`locked."cacheKey"`)}
      RETURNING ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
    `,
    deletedCacheRowSchema,
  );
  signal?.throwIfAborted();
  return deletedRows.length;
}

function resolveStoragePresignedUrls<TRequest>(args: {
  readonly db: Db;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly requests: readonly TRequest[];
  readonly ttlSeconds: number;
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return computed(async (get) => {
    if (args.requests.length === 0) {
      return new Map();
    }

    const requestsByCacheKey = new Map<string, StoragePresignedUrlRequest>();
    for (const request of args.requests) {
      requestsByCacheKey.set(args.cacheKey(request), args.normalize(request));
    }

    const cacheKeys = [...requestsByCacheKey.keys()];
    const rows = await args.db
      .select({
        cacheKey: systemStoragePresignedUrlCache.cacheKey,
        presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
        expiresAt: systemStoragePresignedUrlCache.expiresAt,
      })
      .from(systemStoragePresignedUrlCache)
      .where(
        and(
          eq(systemStoragePresignedUrlCache.scope, args.scope),
          inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys),
        ),
      );

    const rowByCacheKey = new Map(
      rows.map((row) => {
        return [row.cacheKey, row];
      }),
    );
    const issuedAt = nowDate();
    const results = new Map<string, StoragePresignedUrlResult>();
    const needsFresh: {
      readonly cacheKey: string;
      readonly request: StoragePresignedUrlRequest;
    }[] = [];

    for (const [cacheKey, request] of requestsByCacheKey) {
      const row = rowByCacheKey.get(cacheKey);
      if (row && row.expiresAt > issuedAt) {
        results.set(cacheKey, {
          cacheKey,
          url: row.presignedUrl,
          expiresAt: row.expiresAt,
          status: "hit",
        });
        continue;
      }

      needsFresh.push({
        cacheKey,
        request,
      });
    }

    const freshValues = await joinAll(
      needsFresh.map((entry) => {
        return get(
          signCacheValue({
            request: entry.request,
            cacheKey: entry.cacheKey,
            ttlSeconds: args.ttlSeconds,
            issuedAt,
            lastRequestedAt: issuedAt,
          }),
        );
      }),
    );
    await upsertCacheValues(args.db, freshValues);

    for (let index = 0; index < needsFresh.length; index += 1) {
      const entry = needsFresh[index];
      const value = freshValues[index];
      if (!entry || !value) {
        continue;
      }
      results.set(entry.cacheKey, {
        cacheKey: entry.cacheKey,
        url: value.presignedUrl,
        expiresAt: value.expiresAt,
        status: "miss",
      });
    }

    return results;
  });
}

export function resolveSystemStoragePresignedUrls(args: {
  readonly db: Db;
  readonly requests: readonly SystemStoragePresignedUrlRequest[];
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return resolveStoragePresignedUrls({
    ...args,
    scope: "system_storage",
    ttlSeconds: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    cacheKey: systemStoragePresignedUrlCacheKey,
    normalize: systemStorageRequest,
  });
}

export function resolveWorkflowSkillStoragePresignedUrls(args: {
  readonly db: Db;
  readonly requests: readonly WorkflowSkillStoragePresignedUrlRequest[];
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return resolveStoragePresignedUrls({
    ...args,
    scope: "workflow_skill_storage",
    ttlSeconds: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    cacheKey: workflowSkillStoragePresignedUrlCacheKey,
    normalize: workflowSkillStorageRequest,
  });
}

export function resolveReadOnlyStoragePresignedUrls(args: {
  readonly db: Db;
  readonly requests: readonly ReadOnlyStoragePresignedUrlRequest[];
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return resolveStoragePresignedUrls({
    ...args,
    scope: "readonly_storage",
    ttlSeconds: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    cacheKey: readOnlyStoragePresignedUrlCacheKey,
    normalize: readOnlyStorageRequest,
  });
}

export function resolvePresentationTemplatePreviewPresignedUrls(args: {
  readonly db: Db;
  readonly requests: readonly PresentationTemplatePreviewPresignedUrlRequest[];
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return resolveStoragePresignedUrls({
    ...args,
    scope: "presentation_template_preview",
    ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
    cacheKey: presentationTemplatePreviewPresignedUrlCacheKey,
    normalize: presentationTemplatePreviewRequest,
  });
}

export const pruneStoragePresignedUrls$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly scope: StoragePresignedUrlCacheScope;
      readonly limit: number;
      readonly objectKeyPrefix?: string;
    },
    signal: AbortSignal,
  ) => {
    const pruned = await pruneExpiredCacheRows(
      { ...args, objectKeyPrefix: args.objectKeyPrefix, issuedAt: nowDate() },
      signal,
    );
    return { pruned };
  },
);
