import { testStorageObjectCleanupContract } from "@okouai/api-contracts/contracts/test-storage-object-cleanup";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  executeStorageObjectCleanupWork$,
  STORAGE_OBJECT_CLEANUP_JOB_KIND,
} from "../services/storage-object-cleanup.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testStorageObjectCleanupContract.retry);

const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  // There is no production endpoint to advance a cleanup retry's backoff.
  // Only this test-owned user's or organization's durable jobs are eligible.
  const jobs = await set(writeDb$)
    .update(backgroundJobs)
    .set({ availableAt: new Date(0) })
    .where(
      and(
        eq(backgroundJobs.kind, STORAGE_OBJECT_CLEANUP_JOB_KIND),
        eq(backgroundJobs.status, "pending"),
        body.data.kind === "user"
          ? eq(backgroundJobs.userId, body.data.userId)
          : eq(backgroundJobs.orgId, body.data.orgId),
      ),
    )
    .returning({ id: backgroundJobs.id });
  signal.throwIfAborted();
  const result = await set(
    executeStorageObjectCleanupWork$,
    {
      jobIds: jobs.map((job) => {
        return job.id;
      }),
    },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const testStorageObjectCleanupRoutes: readonly RouteEntry[] = [
  { route: testStorageObjectCleanupContract.retry, handler: retry$ },
];
