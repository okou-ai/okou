import { createHash } from "node:crypto";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { joinAll, safeSync } from "../utils";
import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { now, nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import {
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type StoragePresignedUrlCacheScope =
  | "system_storage"
  | "workflow_skill_storage"
  | "readonly_storage"
  | "presentation_template_preview"
  | "artifact_read"
  | "private_artifact_preview";

export type StorageManifestPresignedUrlCacheScope = Exclude<
  StoragePresignedUrlCacheScope,
  "presentation_template_preview" | "artifact_read" | "private_artifact_preview"
>;

export type StorageManifestCacheBranch =
  | "requested"
  | "session_writeback"
  | "captured";
export type StorageManifestCacheEntryKind =
  | "compose"
  | "additional"
  | "artifact";

export interface StorageManifestCacheObservationContext {
  readonly timing: ApiDispatchTimingCollector;
  readonly branch: StorageManifestCacheBranch;
  readonly entryKind: StorageManifestCacheEntryKind;
}

export interface StorageManifestCacheMixedLookupObservationContext {
  readonly timing: ApiDispatchTimingCollector;
  readonly branch: StorageManifestCacheBranch;
}

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
export const PRIVATE_ARTIFACT_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT = 512;
const STORAGE_MANIFEST_PRESIGNED_URL_MIXED_LOOKUP_MAX_PAIRS = 51;
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

type StorageManifestCacheCountBucket =
  | "0"
  | "1"
  | "2_4"
  | "5_8"
  | "9_16"
  | "17_plus";

type StorageManifestPrefetchCountBucket =
  | "0"
  | "1"
  | "2_4"
  | "5_8"
  | "9_16"
  | "17_32"
  | "33_51"
  | "52_64"
  | "65_96"
  | "97_128"
  | "129_plus";

type StorageManifestPrefetchDecision =
  | "insufficient_groups"
  | "over_request_limit"
  | "no_pairs"
  | "over_unique_pair_limit"
  | "mixed_lookup_selected";

interface StorageManifestCacheObservationStats {
  readonly requestedCount: number;
  uniqueKeyCount: number;
  hitCount: number;
  hardExpiredCount: number;
  missingCount: number;
  freshCount: number;
}

interface StorageManifestCacheTimingWindow {
  startedAt: number;
  finishedAt: number | undefined;
}

const STORAGE_MANIFEST_CACHE_ACTION_TYPES = [
  "api_dispatch_prepare_storage_manifest_cache_prepare_requests",
  "api_dispatch_prepare_storage_manifest_cache_lookup",
  "api_dispatch_prepare_storage_manifest_cache_classify",
  "api_dispatch_prepare_storage_manifest_cache_sign_misses",
  "api_dispatch_prepare_storage_manifest_cache_upsert_misses",
] as const satisfies readonly ApiDispatchTimingActionType[];

type StorageManifestCacheActionType =
  (typeof STORAGE_MANIFEST_CACHE_ACTION_TYPES)[number];

function storageManifestCacheCountBucket(
  count: number,
): StorageManifestCacheCountBucket {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function storageManifestPrefetchCountBucket(
  count: number,
): StorageManifestPrefetchCountBucket {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  if (count <= 32) {
    return "17_32";
  }
  // Telemetry bucket ranges stay stable if the lookup limit changes.
  if (count <= 51) {
    return "33_51";
  }
  if (count <= 64) {
    return "52_64";
  }
  if (count <= 96) {
    return "65_96";
  }
  if (count <= 128) {
    return "97_128";
  }
  return "129_plus";
}

class StorageManifestCacheTiming {
  private readonly windows = new Map<
    StorageManifestCacheActionType,
    StorageManifestCacheTimingWindow
  >();

  constructor(
    private readonly context: StorageManifestCacheObservationContext,
    private readonly scope: StorageManifestPresignedUrlCacheScope,
    private readonly stats: StorageManifestCacheObservationStats,
  ) {}

  measureSync<T>(
    actionType: StorageManifestCacheActionType,
    operation: () => T,
  ): T {
    const window = this.start(actionType);
    const result = safeSync(operation);
    window.finishedAt = now();
    if ("error" in result) {
      throw result.error;
    }
    return result.ok;
  }

  async measure<T>(
    actionType: StorageManifestCacheActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const window = this.start(actionType);
    return await (async () => {
      return await operation();
    })().finally(() => {
      window.finishedAt = now();
    });
  }

  flush(): void {
    const dimensions = Object.freeze({
      storage_manifest_branch: this.context.branch,
      storage_manifest_entry_kind: this.context.entryKind,
      storage_manifest_cache_scope: this.scope,
      storage_manifest_cache_requested_count_bucket:
        storageManifestCacheCountBucket(this.stats.requestedCount),
      storage_manifest_cache_unique_key_count_bucket:
        storageManifestCacheCountBucket(this.stats.uniqueKeyCount),
      storage_manifest_cache_hit_count_bucket: storageManifestCacheCountBucket(
        this.stats.hitCount,
      ),
      storage_manifest_cache_hard_expired_count_bucket:
        storageManifestCacheCountBucket(this.stats.hardExpiredCount),
      storage_manifest_cache_missing_count_bucket:
        storageManifestCacheCountBucket(this.stats.missingCount),
      storage_manifest_cache_fresh_count_bucket:
        storageManifestCacheCountBucket(this.stats.freshCount),
    }) satisfies ApiDispatchTimingDimensions;

    for (const actionType of STORAGE_MANIFEST_CACHE_ACTION_TYPES) {
      const window = this.windows.get(actionType);
      if (!window) {
        continue;
      }
      const finishedAt = window.finishedAt ?? now();
      this.context.timing.recordElapsed(
        actionType,
        "nested",
        window.startedAt,
        finishedAt,
        dimensions,
      );
    }
  }

  private start(
    actionType: StorageManifestCacheActionType,
  ): StorageManifestCacheTimingWindow {
    const window = { startedAt: now(), finishedAt: undefined };
    this.windows.set(actionType, window);
    return window;
  }
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
    const signed = {
      url: await get(
        generatePresignedGetUrl(
          args.request.bucket,
          args.request.objectKey,
          undefined,
          args.request.publicEndpoint,
        ),
      ),
      expiresAt: expirationFromIssuedAt(
        args.issuedAt,
        args.ttlSeconds,
      ).toISOString(),
    };
    const expiresAt = new Date(signed.expiresAt);
    return {
      cacheKey: args.cacheKey,
      scope: args.request.scope,
      bucket: args.request.bucket,
      objectKey: args.request.objectKey,
      storageVersionId: args.request.storageVersionId,
      resolvedOrgId: args.request.resolvedOrgId,
      publicEndpoint: args.request.publicEndpoint,
      ttlSeconds: args.ttlSeconds,
      presignedUrl: signed.url,
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

export interface SelectedStoragePresignedUrlCacheRow {
  readonly cacheKey: string;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
}

export interface StorageManifestPresignedUrlCacheSnapshot {
  readonly rowsByScope: ReadonlyMap<
    StorageManifestPresignedUrlCacheScope,
    ReadonlyMap<string, SelectedStoragePresignedUrlCacheRow>
  >;
}

export interface StorageManifestPresignedUrlCachePrefetchInput {
  readonly systemRequests: readonly SystemStoragePresignedUrlRequest[];
  readonly workflowSkillRequests: readonly WorkflowSkillStoragePresignedUrlRequest[];
  readonly readOnlyRequests: readonly ReadOnlyStoragePresignedUrlRequest[];
  readonly logicalLookupCount: number;
}

interface StoragePresignedUrlFreshRequest {
  readonly cacheKey: string;
  readonly request: StoragePresignedUrlRequest;
}

function prepareStoragePresignedUrlRequests<TRequest>(args: {
  readonly requests: readonly TRequest[];
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
  readonly stats: StorageManifestCacheObservationStats;
}): ReadonlyMap<string, StoragePresignedUrlRequest> {
  const requestsByCacheKey = new Map<string, StoragePresignedUrlRequest>();
  for (const request of args.requests) {
    requestsByCacheKey.set(args.cacheKey(request), args.normalize(request));
    args.stats.uniqueKeyCount = requestsByCacheKey.size;
  }
  return requestsByCacheKey;
}

interface StorageManifestPresignedUrlCacheLookupPair {
  readonly scope: StorageManifestPresignedUrlCacheScope;
  readonly cacheKey: string;
}

function recordStorageManifestPrefetchDecision(args: {
  readonly observation:
    | StorageManifestCacheMixedLookupObservationContext
    | undefined;
  readonly decision: StorageManifestPrefetchDecision;
  readonly requestedCount: number;
  readonly logicalLookupCount: number;
  readonly uniquePairCount?: number;
}): void {
  if (!args.observation) {
    return;
  }
  args.observation.timing.recordDuration(
    "api_dispatch_prepare_storage_manifest_cache_prefetch_decision",
    "nested",
    0,
    now(),
    {
      storage_manifest_branch: args.observation.branch,
      storage_manifest_cache_prefetch_decision: args.decision,
      storage_manifest_cache_prefetch_requested_count_bucket:
        storageManifestPrefetchCountBucket(args.requestedCount),
      storage_manifest_cache_logical_lookup_count_bucket:
        storageManifestCacheCountBucket(args.logicalLookupCount),
      ...(args.uniquePairCount === undefined
        ? {}
        : {
            storage_manifest_cache_prefetch_unique_pair_count_bucket:
              storageManifestPrefetchCountBucket(args.uniquePairCount),
          }),
    },
  );
}

function storageManifestPresignedUrlCacheLookupPairs(
  input: StorageManifestPresignedUrlCachePrefetchInput,
): readonly StorageManifestPresignedUrlCacheLookupPair[] {
  const cacheKeysByScope = new Map<
    StorageManifestPresignedUrlCacheScope,
    Set<string>
  >();
  const add = (
    scope: StorageManifestPresignedUrlCacheScope,
    cacheKey: string,
  ) => {
    const cacheKeys = cacheKeysByScope.get(scope) ?? new Set<string>();
    cacheKeys.add(cacheKey);
    cacheKeysByScope.set(scope, cacheKeys);
  };
  for (const request of input.systemRequests) {
    add("system_storage", systemStoragePresignedUrlCacheKey(request));
  }
  for (const request of input.workflowSkillRequests) {
    add(
      "workflow_skill_storage",
      workflowSkillStoragePresignedUrlCacheKey(request),
    );
  }
  for (const request of input.readOnlyRequests) {
    add("readonly_storage", readOnlyStoragePresignedUrlCacheKey(request));
  }
  return [...cacheKeysByScope]
    .flatMap(([scope, cacheKeys]) => {
      return [...cacheKeys].map((cacheKey) => {
        return { scope, cacheKey };
      });
    })
    .sort((left, right) => {
      return (
        left.scope.localeCompare(right.scope) ||
        left.cacheKey.localeCompare(right.cacheKey)
      );
    });
}

export function prefetchStorageManifestPresignedUrlCacheRows(args: {
  readonly db: Db;
  readonly input: StorageManifestPresignedUrlCachePrefetchInput;
  readonly observation?: StorageManifestCacheMixedLookupObservationContext;
}): Computed<Promise<StorageManifestPresignedUrlCacheSnapshot | undefined>> {
  return computed(async () => {
    const requestedCount =
      args.input.systemRequests.length +
      args.input.workflowSkillRequests.length +
      args.input.readOnlyRequests.length;
    if (args.input.logicalLookupCount < 2) {
      recordStorageManifestPrefetchDecision({
        observation: args.observation,
        decision: "insufficient_groups",
        requestedCount,
        logicalLookupCount: args.input.logicalLookupCount,
      });
      return undefined;
    }
    if (
      requestedCount > STORAGE_MANIFEST_PRESIGNED_URL_MIXED_LOOKUP_MAX_PAIRS
    ) {
      recordStorageManifestPrefetchDecision({
        observation: args.observation,
        decision: "over_request_limit",
        requestedCount,
        logicalLookupCount: args.input.logicalLookupCount,
      });
      return undefined;
    }
    const pairs = storageManifestPresignedUrlCacheLookupPairs(args.input);
    if (pairs.length === 0) {
      recordStorageManifestPrefetchDecision({
        observation: args.observation,
        decision: "no_pairs",
        requestedCount,
        logicalLookupCount: args.input.logicalLookupCount,
        uniquePairCount: pairs.length,
      });
      return undefined;
    }
    if (pairs.length > STORAGE_MANIFEST_PRESIGNED_URL_MIXED_LOOKUP_MAX_PAIRS) {
      recordStorageManifestPrefetchDecision({
        observation: args.observation,
        decision: "over_unique_pair_limit",
        requestedCount,
        logicalLookupCount: args.input.logicalLookupCount,
        uniquePairCount: pairs.length,
      });
      return undefined;
    }

    recordStorageManifestPrefetchDecision({
      observation: args.observation,
      decision: "mixed_lookup_selected",
      requestedCount,
      logicalLookupCount: args.input.logicalLookupCount,
      uniquePairCount: pairs.length,
    });

    const scopes = pairs.map((pair) => {
      return pair.scope;
    });
    const cacheKeys = pairs.map((pair) => {
      return pair.cacheKey;
    });
    const lookup = async () => {
      return await args.db
        .select({
          scope: systemStoragePresignedUrlCache.scope,
          cacheKey: systemStoragePresignedUrlCache.cacheKey,
          presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
        })
        .from(systemStoragePresignedUrlCache)
        .innerJoin(
          sql`unnest(
            ${sql.param(scopes)}::varchar(64)[],
            ${sql.param(cacheKeys)}::varchar(64)[]
          ) AS requested(scope, cache_key)`,
          and(
            eq(systemStoragePresignedUrlCache.scope, sql`requested.scope`),
            eq(
              systemStoragePresignedUrlCache.cacheKey,
              sql`requested.cache_key`,
            ),
          ),
        );
    };
    const rows = await measureApiDispatchTiming(
      args.observation?.timing,
      "api_dispatch_prepare_storage_manifest_cache_mixed_lookup",
      "nested",
      lookup,
      {
        storage_manifest_branch: args.observation?.branch ?? "unobserved",
        storage_manifest_cache_requested_count_bucket:
          storageManifestCacheCountBucket(requestedCount),
        storage_manifest_cache_unique_key_count_bucket:
          storageManifestCacheCountBucket(pairs.length),
        storage_manifest_cache_logical_lookup_count_bucket:
          storageManifestCacheCountBucket(args.input.logicalLookupCount),
      },
    );

    const rowsByScope = new Map<
      StorageManifestPresignedUrlCacheScope,
      Map<string, SelectedStoragePresignedUrlCacheRow>
    >();
    for (const row of rows) {
      const scope = row.scope as StorageManifestPresignedUrlCacheScope;
      const rowsByCacheKey =
        rowsByScope.get(scope) ??
        new Map<string, SelectedStoragePresignedUrlCacheRow>();
      rowsByCacheKey.set(row.cacheKey, {
        cacheKey: row.cacheKey,
        presignedUrl: row.presignedUrl,
        expiresAt: row.expiresAt,
      });
      rowsByScope.set(scope, rowsByCacheKey);
    }
    return { rowsByScope };
  });
}

async function lookupStoragePresignedUrlCacheRows(args: {
  readonly db: Db;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly cacheKeys: readonly string[];
}): Promise<readonly SelectedStoragePresignedUrlCacheRow[]> {
  return await args.db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(
      and(
        eq(systemStoragePresignedUrlCache.scope, args.scope),
        inArray(systemStoragePresignedUrlCache.cacheKey, args.cacheKeys),
      ),
    );
}

async function storagePresignedUrlCacheRows(args: {
  readonly db: Db;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly cacheKeys: readonly string[];
  readonly timing: StorageManifestCacheTiming | undefined;
  readonly prefetchedRows: StorageManifestPresignedUrlCacheSnapshot | undefined;
}): Promise<readonly SelectedStoragePresignedUrlCacheRow[]> {
  if (args.prefetchedRows) {
    const rowsByCacheKey = args.prefetchedRows.rowsByScope.get(
      args.scope as StorageManifestPresignedUrlCacheScope,
    );
    return args.cacheKeys.flatMap((cacheKey) => {
      const row = rowsByCacheKey?.get(cacheKey);
      return row ? [row] : [];
    });
  }
  const lookup = async () => {
    return await lookupStoragePresignedUrlCacheRows({
      db: args.db,
      scope: args.scope,
      cacheKeys: args.cacheKeys,
    });
  };
  return args.timing
    ? await args.timing.measure(
        "api_dispatch_prepare_storage_manifest_cache_lookup",
        lookup,
      )
    : await lookup();
}

function classifyStoragePresignedUrlCacheRows(args: {
  readonly requestsByCacheKey: ReadonlyMap<string, StoragePresignedUrlRequest>;
  readonly rows: readonly SelectedStoragePresignedUrlCacheRow[];
  readonly issuedAt: Date;
  readonly minimumRemainingMs: number;
  readonly results: Map<string, StoragePresignedUrlResult>;
  readonly needsFresh: StoragePresignedUrlFreshRequest[];
  readonly stats: StorageManifestCacheObservationStats;
}): void {
  const rowByCacheKey = new Map(
    args.rows.map((row) => {
      return [row.cacheKey, row];
    }),
  );
  for (const [cacheKey, request] of args.requestsByCacheKey) {
    const row = rowByCacheKey.get(cacheKey);
    if (
      row &&
      row.expiresAt.getTime() - args.issuedAt.getTime() >
        args.minimumRemainingMs
    ) {
      args.stats.hitCount += 1;
      args.results.set(cacheKey, {
        cacheKey,
        url: row.presignedUrl,
        expiresAt: row.expiresAt,
        status: "hit",
      });
      continue;
    }

    if (row) {
      args.stats.hardExpiredCount += 1;
    } else {
      args.stats.missingCount += 1;
    }
    args.stats.freshCount += 1;
    args.needsFresh.push({ cacheKey, request });
  }
}

function appendFreshStoragePresignedUrlResults(args: {
  readonly results: Map<string, StoragePresignedUrlResult>;
  readonly needsFresh: readonly StoragePresignedUrlFreshRequest[];
  readonly freshValues: readonly CacheRowValue[];
}): void {
  for (let index = 0; index < args.needsFresh.length; index += 1) {
    const entry = args.needsFresh[index];
    const value = args.freshValues[index];
    if (!entry || !value) {
      continue;
    }
    args.results.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      url: value.presignedUrl,
      expiresAt: value.expiresAt,
      status: "miss",
    });
  }
}

function resolveStoragePresignedUrls<TRequest>(args: {
  readonly db: Db;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly requests: readonly TRequest[];
  readonly ttlSeconds: number;
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
  readonly issuedAt?: Date;
  readonly minimumRemainingMs?: number;
  readonly observation?: StorageManifestCacheObservationContext;
  readonly prefetchedRows?: StorageManifestPresignedUrlCacheSnapshot;
}): Computed<Promise<ReadonlyMap<string, StoragePresignedUrlResult>>> {
  return computed(async (get) => {
    if (args.requests.length === 0) {
      return new Map();
    }

    const stats: StorageManifestCacheObservationStats = {
      requestedCount: args.requests.length,
      uniqueKeyCount: 0,
      hitCount: 0,
      hardExpiredCount: 0,
      missingCount: 0,
      freshCount: 0,
    };
    const timing =
      args.observation &&
      args.scope !== "presentation_template_preview" &&
      args.scope !== "private_artifact_preview" &&
      args.scope !== "artifact_read"
        ? new StorageManifestCacheTiming(args.observation, args.scope, stats)
        : undefined;

    const resolve = async () => {
      const prepareRequests = () => {
        return prepareStoragePresignedUrlRequests({
          requests: args.requests,
          cacheKey: args.cacheKey,
          normalize: args.normalize,
          stats,
        });
      };
      const requestsByCacheKey = timing
        ? timing.measureSync(
            "api_dispatch_prepare_storage_manifest_cache_prepare_requests",
            prepareRequests,
          )
        : prepareRequests();

      const cacheKeys = [...requestsByCacheKey.keys()];
      const rows = await storagePresignedUrlCacheRows({
        db: args.db,
        scope: args.scope,
        cacheKeys,
        timing,
        prefetchedRows: args.prefetchedRows,
      });

      const issuedAt = args.issuedAt ?? nowDate();
      const results = new Map<string, StoragePresignedUrlResult>();
      const needsFresh: StoragePresignedUrlFreshRequest[] = [];
      const classify = () => {
        classifyStoragePresignedUrlCacheRows({
          requestsByCacheKey,
          rows,
          issuedAt,
          minimumRemainingMs: args.minimumRemainingMs ?? 0,
          results,
          needsFresh,
          stats,
        });
      };
      if (timing) {
        timing.measureSync(
          "api_dispatch_prepare_storage_manifest_cache_classify",
          classify,
        );
      } else {
        classify();
      }

      const signMisses = async () => {
        return await joinAll(
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
      };
      const freshValues = timing
        ? await timing.measure(
            "api_dispatch_prepare_storage_manifest_cache_sign_misses",
            signMisses,
          )
        : await signMisses();
      const upsertMisses = async () => {
        await upsertCacheValues(args.db, freshValues);
      };
      if (timing) {
        await timing.measure(
          "api_dispatch_prepare_storage_manifest_cache_upsert_misses",
          upsertMisses,
        );
      } else {
        await upsertMisses();
      }

      appendFreshStoragePresignedUrlResults({
        results,
        needsFresh,
        freshValues,
      });

      return results;
    };
    return timing
      ? await resolve().finally(() => {
          timing.flush();
        })
      : await resolve();
  });
}

export function resolveSystemStoragePresignedUrls(args: {
  readonly db: Db;
  readonly requests: readonly SystemStoragePresignedUrlRequest[];
  readonly observation?: StorageManifestCacheObservationContext;
  readonly prefetchedRows?: StorageManifestPresignedUrlCacheSnapshot;
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
  readonly observation?: StorageManifestCacheObservationContext;
  readonly prefetchedRows?: StorageManifestPresignedUrlCacheSnapshot;
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
  readonly observation?: StorageManifestCacheObservationContext;
  readonly prefetchedRows?: StorageManifestPresignedUrlCacheSnapshot;
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
