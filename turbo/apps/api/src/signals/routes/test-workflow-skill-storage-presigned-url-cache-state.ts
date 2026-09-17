import {
  testWorkflowSkillStoragePresignedUrlCacheStateContract,
  type TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
} from "@okouai/api-contracts/contracts/test-workflow-skill-storage-presigned-url-cache-state";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { command } from "ccstate";
import { and, eq, like, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testWorkflowSkillStoragePresignedUrlCacheStateContract.action,
);

type CacheStateAction<
  TAction extends
    TestWorkflowSkillStoragePresignedUrlCacheStateActionBody["action"],
> = Extract<
  TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
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

type CacheScope = "workflow_skill_storage" | "readonly_storage";

function cacheScope(scope: CacheScope | undefined): CacheScope {
  return scope ?? "workflow_skill_storage";
}

function objectKeyPrefixCondition(prefix: string, scope: CacheScope) {
  return and(
    eq(systemStoragePresignedUrlCache.scope, scope),
    sql`${like(systemStoragePresignedUrlCache.objectKey, escapedLikePrefix(prefix))} escape '\\'`,
  );
}

async function cleanupForAction(
  db: Db,
  body: CacheStateAction<"cleanup">,
  signal: AbortSignal,
) {
  await db
    .delete(systemStoragePresignedUrlCache)
    .where(
      objectKeyPrefixCondition(body.object_key_prefix, cacheScope(body.scope)),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function readCacheByObjectKeyPrefixForAction(
  db: Db,
  body: CacheStateAction<"read-cache-by-object-key-prefix">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      bucket: systemStoragePresignedUrlCache.bucket,
      objectKey: systemStoragePresignedUrlCache.objectKey,
      storageVersionId: systemStoragePresignedUrlCache.storageVersionId,
      resolvedOrgId: systemStoragePresignedUrlCache.resolvedOrgId,
      publicEndpoint: systemStoragePresignedUrlCache.publicEndpoint,
      ttlSeconds: systemStoragePresignedUrlCache.ttlSeconds,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
      refreshAfter: systemStoragePresignedUrlCache.refreshAfter,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(
      objectKeyPrefixCondition(body.object_key_prefix, cacheScope(body.scope)),
    );
  signal.throwIfAborted();
  return actionOk({
    rows: rows.map((row) => {
      return {
        cache_key: row.cacheKey,
        bucket: row.bucket,
        object_key: row.objectKey,
        storage_version_id: row.storageVersionId,
        resolved_org_id: row.resolvedOrgId,
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

const mutateWorkflowSkillStoragePresignedUrlCacheState$ = command(
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
      case "read-cache-by-object-key-prefix": {
        return await readCacheByObjectKeyPrefixForAction(db, body, signal);
      }
    }
  },
);

export const testWorkflowSkillStoragePresignedUrlCacheStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testWorkflowSkillStoragePresignedUrlCacheStateContract.action,
      handler: mutateWorkflowSkillStoragePresignedUrlCacheState$,
    },
  ];
