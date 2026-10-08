import { PRIVATE_ARTIFACT_CACHE_CONTROL } from "@okouai/api-contracts/contracts/artifact-cache";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisition,
  type PgPoolAcquisitionCapture,
} from "../../lib/db-instrumentation";
import { executeRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { now, nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  presignedGetUrlSignerForBucket,
  signPresignedGetUrl$,
  type PresignedGetUrlSigner,
} from "../external/s3";
import { onRejection, safeSync } from "../utils";
import type {
  ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type StoragePresignedUrlCacheScope =
  | "system_storage"
  | "workflow_skill_storage"
  | "readonly_storage"
  | "presentation_template_preview"
  | "private_artifact_preview";

export type StorageManifestPresignedUrlCacheScope = Exclude<
  StoragePresignedUrlCacheScope,
  "presentation_template_preview" | "private_artifact_preview"
>;

export type StorageManifestCacheBranch =
  "requested" | "session_writeback" | "captured";
export type StorageManifestCacheEntryKind =
  "compose" | "additional" | "artifact";

export interface StorageManifestCacheObservationContext {
  readonly timing: ApiDispatchTimingCollector;
  readonly branch: StorageManifestCacheBranch;
  readonly entryKind: StorageManifestCacheEntryKind;
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
const PRIVATE_ARTIFACT_PREVIEW_PRESIGNED_URL_CACHE_POLICY =
  "private-artifact-preview-url-v1";
export const PRIVATE_ARTIFACT_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT = 512;
// Leave time for clients and asynchronous providers to fetch a returned URL.
const PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS = 60 * 60 * 1000;
// Leave enough time for Runner launch and archive downloads after cache selection.
const STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS = 4 * 60 * 60 * 1000;
const deletedCacheRowSchema = z.object({ cacheKey: z.string() });

type StoragePresignedUrlCacheStatus = "hit" | "miss";

export type SystemStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;
export type WorkflowSkillStoragePresignedUrlCacheStatus =
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

export interface PrivateArtifactPreviewPresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly filename?: string;
}

interface StoragePresignedUrlRequest {
  readonly scope: StoragePresignedUrlCacheScope;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
  readonly publicEndpoint: boolean;
  readonly filename?: string;
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
  "0" | "1" | "2_4" | "5_8" | "9_16" | "17_plus";

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

export function storageManifestCacheCountBucket(
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

class StorageManifestCacheTiming {
  private readonly windows = new Map<
    StorageManifestCacheActionType,
    StorageManifestCacheTimingWindow
  >();
  private readonly poolAcquisitions: PgPoolAcquisition[] = [];

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

  recordPoolAcquisitions(acquisitions: readonly PgPoolAcquisition[]): void {
    this.poolAcquisitions.push(...acquisitions);
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
        actionType === "api_dispatch_prepare_storage_manifest_cache_lookup"
          ? {
              ...dimensions,
              storage_manifest_cache_pool_acquire_count_bucket:
                storageManifestCacheCountBucket(this.poolAcquisitions.length),
            }
          : dimensions,
      );
    }
    for (const acquisition of this.poolAcquisitions) {
      this.context.timing.recordDuration(
        "api_dispatch_prepare_storage_manifest_cache_pool_acquire",
        "nested",
        acquisition.durationMs,
        now(),
        {
          ...dimensions,
          storage_manifest_cache_lookup_kind: "legacy",
          storage_manifest_cache_pool_acquire_path: acquisition.path,
        },
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

/** The same canonical JSON key as the JS signer's key, for index/cache JOINs. */
export function storagePresignedUrlCacheKeySql(
  scope: StorageManifestPresignedUrlCacheScope,
  request: {
    readonly bucket: string;
    readonly objectKey: SQL;
    readonly storageVersionId: SQL;
    readonly resolvedOrgId: SQL;
  },
): SQL {
  const policy =
    scope === "system_storage"
      ? SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY
      : scope === "workflow_skill_storage"
        ? WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_CACHE_POLICY
        : READ_ONLY_STORAGE_PRESIGNED_URL_CACHE_POLICY;
  const ttl =
    scope === "system_storage"
      ? SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS
      : scope === "workflow_skill_storage"
        ? WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS
        : READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS;
  const values = [
    sql`to_json(${policy}::text)::text`,
    sql`to_json(${request.bucket}::text)::text`,
    sql`to_json(${request.objectKey}::text)::text`,
    sql`to_json(${request.storageVersionId}::text)::text`,
    ...(scope === "system_storage"
      ? []
      : [sql`to_json(${request.resolvedOrgId}::text)::text`]),
    sql`to_json(${"public"}::text)::text`,
    sql`to_json(${ttl}::integer)::text`,
  ];
  return sql`encode(sha256(convert_to('[' || ${sql.join(values, sql` || ',' || `)} || ']', 'UTF8')), 'hex')`;
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

export function privateArtifactPreviewPresignedUrlCacheKey(
  request: PrivateArtifactPreviewPresignedUrlRequest,
): string {
  // Credential values are hashed into the key so rotation invalidates old URLs.
  return createHash("sha256")
    .update(
      JSON.stringify([
        PRIVATE_ARTIFACT_PREVIEW_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.filename ?? null,
        env("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID"),
        env("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY"),
        env("S3_PUBLIC_ENDPOINT") ?? env("S3_ENDPOINT") ?? env("R2_ACCOUNT_ID"),
        env("S3_REGION"),
        env("S3_FORCE_PATH_STYLE"),
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

function privateArtifactPreviewRequest(
  request: PrivateArtifactPreviewPresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "private_artifact_preview",
    bucket: request.bucket,
    objectKey: request.objectKey,
    // The private object key is unique to its allocation or share snapshot.
    storageVersionId: createHash("sha256")
      .update(request.objectKey)
      .digest("hex"),
    resolvedOrgId: null,
    publicEndpoint: true,
    ...(request.filename !== undefined ? { filename: request.filename } : {}),
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

interface CacheSigningRequest {
  readonly request: StoragePresignedUrlRequest;
  readonly cacheKey: string;
  readonly ttlSeconds: number;
  readonly issuedAt: Date;
  readonly lastRequestedAt: Date;
}

function cacheSigningOptions(args: CacheSigningRequest) {
  const privatePreview = args.request.scope === "private_artifact_preview";
  const signingDate = privatePreview
    ? new Date(Math.floor(args.issuedAt.getTime() / 1000) * 1000)
    : undefined;
  return {
    filename: privatePreview ? args.request.filename : undefined,
    signingDate,
    responseCacheControl:
      args.request.bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
        ? PRIVATE_ARTIFACT_CACHE_CONTROL
        : undefined,
  };
}

function signedCacheValue(
  args: CacheSigningRequest,
  presignedUrl: string,
): CacheRowValue {
  const privatePreview = args.request.scope === "private_artifact_preview";
  const signingDate = privatePreview
    ? new Date(Math.floor(args.issuedAt.getTime() / 1000) * 1000)
    : undefined;
  const expiresAt = expirationFromIssuedAt(
    signingDate ?? args.issuedAt,
    privatePreview ? PRESIGNED_URL_TTL_SECONDS : args.ttlSeconds,
  );
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
}

async function signCacheValue(
  args: CacheSigningRequest & {
    readonly sign: PresignedGetUrlSigner;
  },
): Promise<CacheRowValue> {
  const presignedUrl = await args.sign(
    args.request.bucket,
    args.request.objectKey,
    cacheSigningOptions(args),
  );
  return signedCacheValue(args, presignedUrl);
}

function storagePresignedUrlCacheValues(values: readonly CacheRowValue[]) {
  return [...values]
    .sort((left, right) => {
      return left.cacheKey.localeCompare(right.cacheKey);
    })
    .map((value) => {
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
    });
}

function storagePresignedUrlCacheConflictSet() {
  return {
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
}

async function upsertCacheValues(
  db: Db,
  values: readonly CacheRowValue[],
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  await db
    .insert(systemStoragePresignedUrlCache)
    .values(storagePresignedUrlCacheValues(values))
    .onConflictDoUpdate({
      target: systemStoragePresignedUrlCache.cacheKey,
      set: storagePresignedUrlCacheConflictSet(),
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
  readonly cacheKeysByRequest: WeakMap<
    object,
    StorageManifestPresignedUrlCacheLookupPair
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

function prepareStoragePresignedUrlRequests<TRequest extends object>(args: {
  readonly requests: readonly TRequest[];
  readonly scope: StoragePresignedUrlCacheScope;
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
  readonly stats: StorageManifestCacheObservationStats;
  readonly prefetchedRows: StorageManifestPresignedUrlCacheSnapshot | undefined;
}): ReadonlyMap<string, StoragePresignedUrlRequest> {
  const requestsByCacheKey = new Map<string, StoragePresignedUrlRequest>();
  for (const request of args.requests) {
    const prefetched = args.prefetchedRows?.cacheKeysByRequest.get(request);
    const cacheKey =
      prefetched?.scope === args.scope
        ? prefetched.cacheKey
        : args.cacheKey(request);
    requestsByCacheKey.set(cacheKey, args.normalize(request));
    args.stats.uniqueKeyCount = requestsByCacheKey.size;
  }
  return requestsByCacheKey;
}

interface StorageManifestPresignedUrlCacheLookupPair {
  readonly scope: StorageManifestPresignedUrlCacheScope;
  readonly cacheKey: string;
}

export function storageManifestPresignedUrlCacheLookupPairs(
  input: StorageManifestPresignedUrlCachePrefetchInput,
  memoizeByValue: boolean,
): {
  readonly pairs: readonly StorageManifestPresignedUrlCacheLookupPair[];
  readonly cacheKeysByRequest: StorageManifestPresignedUrlCacheSnapshot["cacheKeysByRequest"];
} {
  const cacheKeysByScope = new Map<
    StorageManifestPresignedUrlCacheScope,
    Set<string>
  >();
  const cacheKeysByRequest: StorageManifestPresignedUrlCacheSnapshot["cacheKeysByRequest"] =
    new WeakMap();
  const cacheKeysByValue = memoizeByValue
    ? new Map<string, string>()
    : undefined;
  const lookupCacheKey = <TRequest extends SystemStoragePresignedUrlRequest>(
    scope: StorageManifestPresignedUrlCacheScope,
    request: TRequest,
    calculate: (value: TRequest) => string,
  ): string => {
    if (!cacheKeysByValue) {
      return calculate(request);
    }
    const signature = JSON.stringify([
      scope,
      request.bucket,
      request.objectKey,
      request.storageVersionId,
      "resolvedOrgId" in request ? request.resolvedOrgId : null,
      request.publicEndpoint,
    ]);
    const cached = cacheKeysByValue.get(signature);
    if (cached) {
      return cached;
    }
    const cacheKey = calculate(request);
    cacheKeysByValue.set(signature, cacheKey);
    return cacheKey;
  };
  const add = (
    scope: StorageManifestPresignedUrlCacheScope,
    request: object,
    cacheKey: string,
  ) => {
    const cacheKeys = cacheKeysByScope.get(scope) ?? new Set<string>();
    cacheKeys.add(cacheKey);
    cacheKeysByScope.set(scope, cacheKeys);
    cacheKeysByRequest.set(request, { scope, cacheKey });
  };
  for (const request of input.systemRequests) {
    add(
      "system_storage",
      request,
      lookupCacheKey(
        "system_storage",
        request,
        systemStoragePresignedUrlCacheKey,
      ),
    );
  }
  for (const request of input.workflowSkillRequests) {
    add(
      "workflow_skill_storage",
      request,
      lookupCacheKey(
        "workflow_skill_storage",
        request,
        workflowSkillStoragePresignedUrlCacheKey,
      ),
    );
  }
  for (const request of input.readOnlyRequests) {
    add(
      "readonly_storage",
      request,
      lookupCacheKey(
        "readonly_storage",
        request,
        readOnlyStoragePresignedUrlCacheKey,
      ),
    );
  }
  const pairs = [...cacheKeysByScope]
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
  return { pairs, cacheKeysByRequest };
}

async function lookupStoragePresignedUrlCacheRows(args: {
  readonly db: ReadonlyDb;
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
  readonly db: ReadonlyDb;
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
    const query = async () => {
      return await lookupStoragePresignedUrlCacheRows({
        db: args.db,
        scope: args.scope,
        cacheKeys: args.cacheKeys,
      });
    };
    const timing = args.timing;
    if (!timing) {
      return await query();
    }
    const capture: PgPoolAcquisitionCapture = { acquisitions: [] };
    return await withPgPoolAcquisitionCapture(capture, query).finally(() => {
      timing.recordPoolAcquisitions(capture.acquisitions);
    });
  };
  return args.timing
    ? await args.timing.measure(
        "api_dispatch_prepare_storage_manifest_cache_lookup",
        lookup,
      )
    : await lookup();
}

function hasReusablePresignedUrlLifetime(args: {
  readonly scope: StoragePresignedUrlCacheScope;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly minimumRemainingMs?: number;
}): boolean {
  const remainingMs = args.expiresAt.getTime() - args.issuedAt.getTime();
  return (
    remainingMs > (args.minimumRemainingMs ?? 0) &&
    (args.scope === "presentation_template_preview" ||
      args.scope === "private_artifact_preview" ||
      remainingMs >= STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS)
  );
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
      hasReusablePresignedUrlLifetime({
        scope: request.scope,
        expiresAt: row.expiresAt,
        issuedAt: args.issuedAt,
        minimumRemainingMs: args.minimumRemainingMs,
      })
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

interface PreparedStoragePresignedUrls {
  readonly results: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly freshValues: readonly CacheRowValue[];
  readonly timing: StorageManifestCacheTiming | undefined;
}

interface PreparedStoragePresignedUrlRequests {
  readonly results: Map<string, StoragePresignedUrlResult>;
  readonly needsFresh: readonly StoragePresignedUrlFreshRequest[];
  readonly issuedAt: Date;
  readonly ttlSeconds: number;
  readonly timing: StorageManifestCacheTiming | undefined;
}

interface StoragePresignedUrlSigningRequest extends StoragePresignedUrlFreshRequest {
  readonly sign: PresignedGetUrlSigner;
}

async function prepareStoragePresignedUrls<TRequest extends object>(args: {
  readonly db: ReadonlyDb;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly requests: readonly TRequest[];
  readonly ttlSeconds: number;
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
  readonly issuedAt?: Date;
  readonly minimumRemainingMs?: number;
  readonly observation?: StorageManifestCacheObservationContext;
  readonly prefetchedRows?: StorageManifestPresignedUrlCacheSnapshot;
}): Promise<PreparedStoragePresignedUrlRequests> {
  if (args.requests.length === 0) {
    return {
      results: new Map(),
      needsFresh: [],
      issuedAt: args.issuedAt ?? nowDate(),
      ttlSeconds: args.ttlSeconds,
      timing: undefined,
    };
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
    args.scope !== "private_artifact_preview"
      ? new StorageManifestCacheTiming(args.observation, args.scope, stats)
      : undefined;

  const resolve = async () => {
    const prepareRequests = () => {
      return prepareStoragePresignedUrlRequests({
        requests: args.requests,
        scope: args.scope,
        cacheKey: args.cacheKey,
        normalize: args.normalize,
        stats,
        prefetchedRows: args.prefetchedRows,
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

    return {
      results,
      needsFresh,
      issuedAt,
      ttlSeconds: args.ttlSeconds,
      timing,
    };
  };
  return await onRejection(resolve(), () => {
    timing?.flush();
  });
}

async function signPreparedStoragePresignedUrls(
  prepared: PreparedStoragePresignedUrlRequests,
  signingRequests: readonly StoragePresignedUrlSigningRequest[],
): Promise<PreparedStoragePresignedUrls> {
  const signMisses = async () => {
    return await Promise.all(
      signingRequests.map((entry) => {
        return signCacheValue({
          ...entry,
          ttlSeconds: prepared.ttlSeconds,
          issuedAt: prepared.issuedAt,
          lastRequestedAt: prepared.issuedAt,
        });
      }),
    );
  };
  const freshValues = await onRejection(
    prepared.timing
      ? prepared.timing.measure(
          "api_dispatch_prepare_storage_manifest_cache_sign_misses",
          signMisses,
        )
      : signMisses(),
    () => {
      prepared.timing?.flush();
    },
  );
  appendFreshStoragePresignedUrlResults({
    results: prepared.results,
    needsFresh: prepared.needsFresh,
    freshValues,
  });
  return { results: prepared.results, freshValues, timing: prepared.timing };
}

interface ManifestSigningSnapshot {
  readonly input: StorageManifestPresignedUrlCachePrefetchInput;
  readonly prefetchedRows: StorageManifestPresignedUrlCacheSnapshot;
}

/** Classify only captured values; this plan performs no signing or database reads. */
function storageManifestSigningRequests(
  input: StorageManifestPresignedUrlCachePrefetchInput,
) {
  const requests = [
    ...input.systemRequests.map((request) => {
      return {
        cacheKey: systemStoragePresignedUrlCacheKey(request),
        request: systemStorageRequest(request),
        ttlSeconds: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      };
    }),
    ...input.workflowSkillRequests.map((request) => {
      return {
        cacheKey: workflowSkillStoragePresignedUrlCacheKey(request),
        request: workflowSkillStorageRequest(request),
        ttlSeconds: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      };
    }),
    ...input.readOnlyRequests.map((request) => {
      return {
        cacheKey: readOnlyStoragePresignedUrlCacheKey(request),
        request: readOnlyStorageRequest(request),
        ttlSeconds: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      };
    }),
  ];
  return new Map(
    requests.map((entry) => {
      return [entry.cacheKey, entry];
    }),
  );
}

/** Classify the captured cache snapshot at the owner's signing clock. */
function storageManifestSigningPlan(
  unique: ReturnType<typeof storageManifestSigningRequests>,
  prefetchedRows: StorageManifestPresignedUrlCacheSnapshot,
  issuedAt: Date,
) {
  const results = new Map<string, StoragePresignedUrlResult>();
  const missing = [...unique.values()].filter((entry) => {
    const row = prefetchedRows.rowsByScope
      .get(entry.request.scope as StorageManifestPresignedUrlCacheScope)
      ?.get(entry.cacheKey);
    if (
      !row ||
      !hasReusablePresignedUrlLifetime({
        scope: entry.request.scope,
        expiresAt: row.expiresAt,
        issuedAt,
      })
    ) {
      return true;
    }
    results.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      url: row.presignedUrl,
      expiresAt: row.expiresAt,
      status: "hit",
    });
    return false;
  });
  return { results, missing, issuedAt };
}

/** Classify a captured database snapshot and sign misses entirely in memory. */
export async function signStorageManifestPresignedUrls(
  args: ManifestSigningSnapshot & {
    readonly sign: PresignedGetUrlSigner;
  },
): Promise<{
  readonly results: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly freshValues: readonly CacheRowValue[];
}> {
  const requests = storageManifestSigningRequests(args.input);
  const { results, missing, issuedAt } = storageManifestSigningPlan(
    requests,
    args.prefetchedRows,
    nowDate(),
  );
  const freshValues = await Promise.all(
    missing.map((entry) => {
      return signCacheValue({
        ...entry,
        sign: args.sign,
        issuedAt,
        lastRequestedAt: issuedAt,
      });
    }),
  );
  appendFreshStoragePresignedUrlResults({
    results,
    needsFresh: missing,
    freshValues,
  });
  return { results, freshValues };
}

/** Fixed signer command; requests and snapshots never carry an I/O callback. */
export const signStorageManifestPresignedUrls$ = command(
  async ({ set }, args: ManifestSigningSnapshot) => {
    const requests = storageManifestSigningRequests(args.input);
    const { results, missing, issuedAt } = storageManifestSigningPlan(
      requests,
      args.prefetchedRows,
      nowDate(),
    );
    const freshValues = await Promise.all(
      missing.map(async (entry) => {
        const request = { ...entry, issuedAt, lastRequestedAt: issuedAt };
        const presignedUrl = await set(signPresignedGetUrl$, {
          bucket: entry.request.bucket,
          key: entry.request.objectKey,
          publicEndpoint: entry.request.publicEndpoint,
          ...cacheSigningOptions(request),
        });
        return signedCacheValue(request, presignedUrl);
      }),
    );
    appendFreshStoragePresignedUrlResults({
      results,
      needsFresh: missing,
      freshValues,
    });
    return { results, freshValues };
  },
);

async function persistPreparedStoragePresignedUrls(
  db: Db,
  prepared: PreparedStoragePresignedUrls,
): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> {
  const persist = async () => {
    await upsertCacheValues(db, prepared.freshValues);
  };
  if (prepared.timing) {
    await onRejection(
      prepared.timing.measure(
        "api_dispatch_prepare_storage_manifest_cache_upsert_misses",
        persist,
      ),
      () => {
        prepared.timing?.flush();
      },
    );
    prepared.timing.flush();
  } else {
    await persist();
  }
  return prepared.results;
}

function resolveStoragePresignedUrls<TRequest extends object>(args: {
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
    const requests = await prepareStoragePresignedUrls(args);
    const signingRequests = requests.needsFresh.map((entry) => {
      return {
        ...entry,
        sign: get(
          presignedGetUrlSignerForBucket(
            entry.request.bucket,
            entry.request.publicEndpoint,
          ),
        ),
      };
    });
    const prepared = await signPreparedStoragePresignedUrls(
      requests,
      signingRequests,
    );
    return await persistPreparedStoragePresignedUrls(args.db, prepared);
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

export const resolvePrivateArtifactPreviewPresignedUrls$ = command(
  async (
    { get, set },
    args: {
      readonly requests: readonly PrivateArtifactPreviewPresignedUrlRequest[];
      readonly issuedAt?: Date;
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> => {
    if (args.requests.length === 0) {
      return new Map();
    }
    const requestsByCacheKey = new Map(
      args.requests.map((request) => {
        return [
          privateArtifactPreviewPresignedUrlCacheKey(request),
          privateArtifactPreviewRequest(request),
        ];
      }),
    );
    const db = set(writeDb$);
    const rows = await db
      .select({
        cacheKey: systemStoragePresignedUrlCache.cacheKey,
        presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
        expiresAt: systemStoragePresignedUrlCache.expiresAt,
      })
      .from(systemStoragePresignedUrlCache)
      .where(
        and(
          eq(systemStoragePresignedUrlCache.scope, "private_artifact_preview"),
          inArray(systemStoragePresignedUrlCache.cacheKey, [
            ...requestsByCacheKey.keys(),
          ]),
        ),
      );
    signal.throwIfAborted();
    const issuedAt = args.issuedAt ?? nowDate();
    const results = new Map<string, StoragePresignedUrlResult>();
    const needsFresh: StoragePresignedUrlFreshRequest[] = [];
    classifyStoragePresignedUrlCacheRows({
      requestsByCacheKey,
      rows,
      issuedAt,
      minimumRemainingMs: PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS,
      results,
      needsFresh,
      stats: {
        requestedCount: args.requests.length,
        uniqueKeyCount: requestsByCacheKey.size,
        hitCount: 0,
        hardExpiredCount: 0,
        missingCount: 0,
        freshCount: 0,
      },
    });
    const freshValues = await Promise.all(
      needsFresh.map((entry) => {
        return signCacheValue({
          ...entry,
          sign: get(
            presignedGetUrlSignerForBucket(
              entry.request.bucket,
              entry.request.publicEndpoint,
            ),
          ),
          ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
          issuedAt,
          lastRequestedAt: issuedAt,
        });
      }),
    );
    signal.throwIfAborted();
    appendFreshStoragePresignedUrlResults({ results, needsFresh, freshValues });
    if (freshValues.length > 0) {
      await db
        .insert(systemStoragePresignedUrlCache)
        .values(storagePresignedUrlCacheValues(freshValues))
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: storagePresignedUrlCacheConflictSet(),
        });
      signal.throwIfAborted();
    }
    return results;
  },
);

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
