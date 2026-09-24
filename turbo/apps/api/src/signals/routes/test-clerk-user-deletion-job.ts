import { command } from "ccstate";
import { testClerkUserDeletionJobContract } from "@okouai/api-contracts/contracts/test-clerk-user-deletion-job";
import {
  accountErasureJobs,
  accountErasureWork,
} from "@okouai/db/schema/account-erasure";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq, inArray, isNull } from "drizzle-orm";

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
  const db = set(writeDb$);
  const jobs = await db
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
  if (jobs.length > 1) {
    throw new Error("Expected one pending Clerk user deletion job");
  }
  if (!job) {
    return { status: 200 as const, body: { processed: 0 } };
  }
  // The worker's per-sink retry delay also uses the database clock. Advance
  // only this test-owned account's retryable, unleased work; preserve its
  // outcome and evidence so the real worker must still verify completion.
  await db
    .update(accountErasureWork)
    .set({ availableAt: new Date(0) })
    .where(
      and(
        inArray(
          accountErasureWork.jobId,
          db
            .select({ id: accountErasureJobs.id })
            .from(accountErasureJobs)
            .where(
              and(
                eq(accountErasureJobs.subjectKind, "user"),
                eq(accountErasureJobs.subjectId, body.data.userId),
              ),
            ),
        ),
        eq(accountErasureWork.state, "retryable_failure"),
        isNull(accountErasureWork.leaseId),
      ),
    );
  signal.throwIfAborted();
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
