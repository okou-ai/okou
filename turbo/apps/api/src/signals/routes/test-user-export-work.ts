import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { exportJobs } from "@okouai/db/schema/export-job";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { executeDurableUserExportWork$ } from "../services/user-export-durable.service";
import { cleanupDurableUserExports$ } from "../services/user-export-cleanup.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testUserExportWorkContract.action);
const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const result = await get(body$);
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const body = result.data;
  const db = set(writeDb$);
  const condition = and(
    eq(backgroundJobs.id, body.jobId),
    eq(backgroundJobs.userId, body.userId),
    eq(backgroundJobs.kind, "user-export"),
  );
  const [job] = await db
    .select()
    .from(backgroundJobs)
    .where(condition)
    .limit(1);
  signal.throwIfAborted();
  if (!job) {
    if (body.action === "delete") {
      await db
        .delete(exportJobs)
        .where(
          and(
            eq(exportJobs.id, body.jobId),
            eq(exportJobs.userId, body.userId),
          ),
        );
      signal.throwIfAborted();
    }
    return { status: 200 as const, body: { ok: true as const, state: null } };
  }
  switch (body.action) {
    case "cleanup": {
      const work = await set(
        cleanupDurableUserExports$,
        { jobId: body.jobId },
        signal,
      );
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const, ...work } };
    }
    case "make-cleanup-due": {
      await db
        .update(backgroundJobs)
        .set({ updatedAt: new Date(nowDate().getTime() - 3 * 60_000) })
        .where(condition);
      signal.throwIfAborted();
      break;
    }
    case "run": {
      const work = await set(
        executeDurableUserExportWork$,
        { jobId: body.jobId, maxSteps: body.maxSteps ?? 1 },
        signal,
      );
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const, ...work } };
    }
    case "inspect": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          state: {
            status: job.status,
            phase:
              typeof job.checkpoint.phase === "string"
                ? job.checkpoint.phase
                : null,
            failureCount: job.failureCount,
          },
        },
      };
    }
    case "make-due": {
      await db
        .update(backgroundJobs)
        .set({ availableAt: new Date(nowDate().getTime() - 1000) })
        .where(condition);
      signal.throwIfAborted();
      break;
    }
    case "expire-lease": {
      await db
        .update(backgroundJobs)
        .set({ leaseExpiresAt: new Date(nowDate().getTime() - 1000) })
        .where(condition);
      signal.throwIfAborted();
      break;
    }
    case "delete": {
      await db.delete(backgroundJobs).where(condition);
      signal.throwIfAborted();
      await db
        .delete(exportJobs)
        .where(
          and(
            eq(exportJobs.id, body.jobId),
            eq(exportJobs.userId, body.userId),
          ),
        );
      signal.throwIfAborted();
      break;
    }
  }
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
});

export const testUserExportWorkRoutes: readonly RouteEntry[] = [
  { route: testUserExportWorkContract.action, handler: action$ },
];
