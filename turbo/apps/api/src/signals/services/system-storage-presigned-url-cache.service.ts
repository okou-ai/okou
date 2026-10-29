import { PRIVATE_ARTIFACT_CACHE_CONTROL } from "@okouai/api-contracts/contracts/artifact-cache";
import {
  PRESIGNED_URL_TTL_SECONDS,
  PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS,
} from "@okouai/api-contracts/contracts/presigned-urls";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { command } from "ccstate";
import { and, eq, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { object, string } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  presignedGetUrlSignerForBucket,
  type PresignedGetUrlSigner,
} from "../external/s3";

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

export type StorageManifestCacheBranch = "requested" | "captured";
export type StorageManifestCacheEntryKind =
  "compose" | "additional" | "artifact";

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
// Leave enough time for Runner launch and archive downloads after cache selection.
const STORAGE_MANIFEST_PRESIGNED_URL_MIN_REMAINING_MS = 4 * 60 * 60 * 1000;
const deletedCacheRowSchema = object({ cacheKey: string() });

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
  readonly lastRequestedAt: Date;
  readonly updatedAt: Date;
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
    lastRequestedAt: sql`excluded.last_requested_at`,
    updatedAt: sql`excluded.updated_at`,
  };
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

function presentationTemplatePreviewRequests(
  requests: readonly PresentationTemplatePreviewPresignedUrlRequest[],
): ReadonlyMap<string, StoragePresignedUrlRequest> {
  const requestsByCacheKey = new Map<string, StoragePresignedUrlRequest>();
  for (const request of requests) {
    const cacheKey = presentationTemplatePreviewPresignedUrlCacheKey(request);
    requestsByCacheKey.set(
      cacheKey,
      presentationTemplatePreviewRequest(request),
    );
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
      args.results.set(cacheKey, {
        cacheKey,
        url: row.presignedUrl,
        expiresAt: row.expiresAt,
        status: "hit",
      });
      continue;
    }

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

interface PreparedStoragePresignedUrlRequests {
  readonly results: Map<string, StoragePresignedUrlResult>;
  readonly needsFresh: readonly StoragePresignedUrlFreshRequest[];
  readonly issuedAt: Date;
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

/** Callers observe cancellation after this complete finite lookup/sign/write stage. */
export const resolvePresentationTemplatePreviewPresignedUrls$ = command(
  async (
    { get, set },
    args: {
      readonly requests: readonly PresentationTemplatePreviewPresignedUrlRequest[];
    },
  ): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> => {
    const db = set(writeDb$);
    const requests =
      await (async (): Promise<PreparedStoragePresignedUrlRequests> => {
        if (args.requests.length === 0) {
          return { results: new Map(), needsFresh: [], issuedAt: nowDate() };
        }
        const requestsByCacheKey = presentationTemplatePreviewRequests(
          args.requests,
        );
        const cacheKeys = [...requestsByCacheKey.keys()];
        const rows = await db
          .select({
            cacheKey: systemStoragePresignedUrlCache.cacheKey,
            presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
            expiresAt: systemStoragePresignedUrlCache.expiresAt,
          })
          .from(systemStoragePresignedUrlCache)
          .where(
            and(
              eq(
                systemStoragePresignedUrlCache.scope,
                "presentation_template_preview",
              ),
              inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys),
            ),
          );
        const issuedAt = nowDate();
        const results = new Map<string, StoragePresignedUrlResult>();
        const needsFresh: StoragePresignedUrlFreshRequest[] = [];
        classifyStoragePresignedUrlCacheRows({
          requestsByCacheKey,
          rows,
          issuedAt,
          minimumRemainingMs: 0,
          results,
          needsFresh,
        });
        return { results, needsFresh, issuedAt };
      })();
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
    const freshValues = await Promise.all(
      signingRequests.map((entry) => {
        return signCacheValue({
          ...entry,
          ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
          issuedAt: requests.issuedAt,
          lastRequestedAt: requests.issuedAt,
        });
      }),
    );
    appendFreshStoragePresignedUrlResults({
      results: requests.results,
      needsFresh: requests.needsFresh,
      freshValues,
    });
    await (async (): Promise<void> => {
      if (freshValues.length === 0) {
        return;
      }
      await db
        .insert(systemStoragePresignedUrlCache)
        .values(storagePresignedUrlCacheValues(freshValues))
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: storagePresignedUrlCacheConflictSet(),
        });
    })();
    return requests.results;
  },
);

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
    { set },
    input: {
      readonly scope: StoragePresignedUrlCacheScope | "hosted_site_preview";
      readonly limit: number;
      readonly objectKeyPrefix?: string;
    },
    signal: AbortSignal,
  ) => {
    const args = {
      ...input,
      objectKeyPrefix: input.objectKeyPrefix,
      issuedAt: nowDate(),
    };
    const pruned = await (async (signal?: AbortSignal) => {
      const issuedAtTimestamp = timestampWithoutTimeZone(args.issuedAt);
      const db = set(writeDb$);
      const pruneQuery = sql`
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
    `;
      const rowSchema = deletedCacheRowSchema;
      const deletedRows = await (async () => {
        return parseRawRows(rowSchema, await db.execute(pruneQuery));
      })();
      signal?.throwIfAborted();
      return deletedRows.length;
    })(signal);
    return { pruned };
  },
);
