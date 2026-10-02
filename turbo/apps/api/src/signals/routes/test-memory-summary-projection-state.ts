import { createHash } from "node:crypto";

import {
  testMemorySummaryProjectionStateContract,
  type TestMemorySummaryProjectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-memory-summary-projection-state";
import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  executeMemorySummaryProjectionWork$,
  readMemorySummaryProjection$,
} from "../services/memory-summary-projection.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testMemorySummaryProjectionStateContract.action,
);

type ProjectionAction<
  TAction extends TestMemorySummaryProjectionStateActionBody["action"],
> = Extract<TestMemorySummaryProjectionStateActionBody, { action: TAction }>;

type ProjectionScope = Omit<
  TestMemorySummaryProjectionStateActionBody,
  "action" | "content"
>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function projectionCondition(scope: ProjectionScope) {
  return and(
    eq(memorySummaryProjections.memoryStorageId, scope.memory_storage_id),
    eq(memorySummaryProjections.storageVersionId, scope.storage_version_id),
    eq(memorySummaryProjections.orgId, scope.org_id),
    eq(memorySummaryProjections.userId, scope.user_id),
  );
}

async function ownsProjectionSource(
  db: Db,
  scope: ProjectionScope,
  signal: AbortSignal,
): Promise<boolean> {
  const [source] = await db
    .select({ storageId: storages.id })
    .from(storages)
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, scope.storage_version_id),
      ),
    )
    .where(
      and(
        eq(storages.id, scope.memory_storage_id),
        eq(storages.orgId, scope.org_id),
        eq(storages.userId, scope.user_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return source !== undefined;
}

async function inspectProjection(
  db: Db,
  scope: ProjectionScope,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      status: memorySummaryProjections.status,
      attemptCount: memorySummaryProjections.attemptCount,
      availableAt: memorySummaryProjections.availableAt,
      leaseId: memorySummaryProjections.leaseId,
      leaseExpiresAt: memorySummaryProjections.leaseExpiresAt,
      lastErrorClass: memorySummaryProjections.lastErrorClass,
      content: memorySummaryProjections.content,
      sourceHash: memorySummaryProjections.sourceHash,
      sourceSize: memorySummaryProjections.sourceSize,
      tokenCount: memorySummaryProjections.tokenCount,
    })
    .from(memorySummaryProjections)
    .where(projectionCondition(scope))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    state: row
      ? {
          status: row.status,
          attempt_count: row.attemptCount,
          available_at: row.availableAt.toISOString(),
          lease_id: row.leaseId,
          lease_expires_at: row.leaseExpiresAt?.toISOString() ?? null,
          last_error_class: row.lastErrorClass,
          has_content: row.content !== null,
          source_hash: row.sourceHash,
          source_size: row.sourceSize,
          token_count: row.tokenCount,
        }
      : null,
  });
}

async function deleteProjection(
  db: Db,
  scope: ProjectionScope,
  signal: AbortSignal,
) {
  await db.delete(memorySummaryProjections).where(projectionCondition(scope));
  signal.throwIfAborted();
  return actionOk();
}

async function makeProjectionDue(
  db: Db,
  scope: ProjectionScope,
  signal: AbortSignal,
) {
  await db
    .update(memorySummaryProjections)
    .set({ availableAt: new Date(nowDate().getTime() - 1000) })
    .where(projectionCondition(scope));
  signal.throwIfAborted();
  return actionOk();
}

async function seedReadyProjection(
  db: Db,
  body: ProjectionAction<"seed-ready">,
  signal: AbortSignal,
) {
  const bytes = Buffer.from(body.content, "utf8");
  await db
    .update(memorySummaryProjections)
    .set({
      status: "ready",
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorClass: null,
      content: body.content,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      sourceSize: bytes.byteLength,
      tokenCount: encode(body.content).length,
    })
    .where(projectionCondition(body));
  signal.throwIfAborted();
  return actionOk();
}

const action$ = command(async ({ get, set }, signal: AbortSignal) => {
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
  if (body.action === "read") {
    const result = await set(
      readMemorySummaryProjection$,
      {
        orgId: body.org_id,
        userId: body.user_id,
        memoryStorageId: body.memory_storage_id,
        storageVersionId: body.storage_version_id,
      },
      signal,
    );
    return actionOk({
      projection: result
        ? {
            content: result.content,
            source_hash: result.sourceHash,
            source_size: result.sourceSize,
            token_count: result.tokenCount,
          }
        : null,
    });
  }
  if (!(await ownsProjectionSource(db, body, signal))) {
    return actionOk();
  }

  switch (body.action) {
    case "inspect": {
      return await inspectProjection(db, body, signal);
    }
    case "delete": {
      return await deleteProjection(db, body, signal);
    }
    case "make-due": {
      return await makeProjectionDue(db, body, signal);
    }
    case "seed-ready": {
      return await seedReadyProjection(db, body, signal);
    }
    case "run": {
      const result = await set(
        executeMemorySummaryProjectionWork$,
        {
          scope: {
            memoryStorageId: body.memory_storage_id,
            storageVersionId: body.storage_version_id,
          },
          currentTime: body.current_time
            ? new Date(body.current_time)
            : nowDate(),
        },
        signal,
      );
      return actionOk({
        worker: {
          backfilled: result.backfilled,
          claimed: result.claimed,
          ready: result.ready,
          no_content: result.noContent,
          retried: result.retried,
          stale: result.stale,
        },
      });
    }
  }
});

export const testMemorySummaryProjectionStateRoutes: readonly RouteEntry[] = [
  {
    route: testMemorySummaryProjectionStateContract.action,
    handler: action$,
  },
];
