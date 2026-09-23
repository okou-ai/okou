import { command } from "ccstate";
import { testClerkUserDeletionJobContract } from "@okouai/api-contracts/contracts/test-clerk-user-deletion-job";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { executeClerkUserDeletionWork$ } from "../services/clerk-user-deletion-job.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testClerkUserDeletionJobContract.retry);

const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  // Only tests mount this route. No production endpoint can advance a
  // test-owned job past its one-minute retry delay without waiting for time.
  const jobs = await set(writeDb$)
    .update(backgroundJobs)
    .set({ availableAt: new Date(0) })
    .where(
      and(
        eq(backgroundJobs.kind, "clerk-user-deletion"),
        eq(backgroundJobs.userId, body.data.userId),
        eq(backgroundJobs.status, "pending"),
      ),
    )
    .returning({ id: backgroundJobs.id });
  signal.throwIfAborted();
  const [job] = jobs;
  if (!job || jobs.length !== 1) {
    throw new Error("Expected one pending Clerk user deletion job");
  }
  const result = await set(
    executeClerkUserDeletionWork$,
    { jobId: job.id },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const testClerkUserDeletionJobRoutes: readonly RouteEntry[] = [
  { route: testClerkUserDeletionJobContract.retry, handler: retry$ },
];
