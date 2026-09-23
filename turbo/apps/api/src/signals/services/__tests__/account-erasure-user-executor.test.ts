import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Pool } from "pg";
import { expect, onTestFinished, test } from "vitest";

import {
  accountErasureJobs,
  accountErasureSinks,
  accountErasureWork,
} from "@okouai/db/schema/account-erasure";
import { backgroundJobs } from "@okouai/db/schema/background-job";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import {
  claimBackgroundJob,
  enqueueBackgroundJob,
} from "../background-job.service";
import { captureUserErasureWork } from "../account-erasure-user-executor";
import {
  enqueueClerkUserDeletion$,
  executeClerkUserDeletionWork$,
} from "../clerk-user-deletion-job.service";

// B1 persistence has no account-facing status route yet. This integration test
// crosses the DB boundary to prove the durable capture and lease revision that
// the signed webhook worker must resume after a process restart.
const context = testContext();

test("captures bounded file pages once and reuses them after worker lease loss", async () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  onTestFinished(async () => {
    await pool.end();
  });
  const db = drizzle(pool);
  const userId = `synthetic_deleted_${randomUUID()}`;
  const backgroundId = randomUUID();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof Object &&
      command.constructor.name === "HeadObjectCommand"
    ) {
      return Promise.reject(
        Object.assign(new Error("Object absent"), { name: "NoSuchKey" }),
      );
    }
    return Promise.resolve({ Contents: [] });
  });
  const files = Array.from({ length: 45 }, () => {
    return randomUUID();
  });
  for (const id of files) {
    await pool.query(
      "INSERT INTO run_uploaded_files (id, source, external_id, user_id, storage_key, metadata) VALUES ($1, 'web', $2, $3, $4, '{}'::jsonb)",
      [id, id, userId, `artifacts/${id}`],
    );
  }
  await enqueueBackgroundJob(
    db,
    {
      id: backgroundId,
      kind: "clerk-user-deletion",
      handlerVersion: 1,
      userId,
      orgId: "",
      input: {},
    },
    context.signal,
  );
  const first = await claimBackgroundJob(
    db,
    { jobId: backgroundId, kind: "clerk-user-deletion", handlerVersion: 1 },
    context.signal,
  );
  expect(first).toBeDefined();
  if (!first) {
    throw new Error("Missing initial background lease");
  }
  await expect(
    captureUserErasureWork(db, first, context.signal),
  ).rejects.toThrow("account_erasure:required_capture_missing:remote");

  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(captured?.captureRevision).toBe(2);
  expect(captured?.sealedCaptureRevision).toBeNull();
  const sinks = await db
    .select()
    .from(accountErasureSinks)
    .where(eq(accountErasureSinks.jobId, captured?.id ?? ""));
  expect(sinks).toHaveLength(13);
  const inventory = await db
    .select()
    .from(accountErasureWork)
    .where(eq(accountErasureWork.jobId, captured?.id ?? ""));
  expect(
    inventory.filter((item) => {
      return item.kind === "inventory";
    }),
  ).toHaveLength(13);
  expect(
    inventory.every((item) => {
      return item.kind !== "inventory" || item.captureComplete;
    }),
  ).toBeTruthy();
  expect(
    inventory
      .filter((item) => {
        return item.kind === "inventory";
      })
      .every((item) => {
        return item.attemptCount === 0;
      }),
  ).toBeTruthy();

  // Reclaim exactly the persisted background job after its owner disappears.
  await db
    .update(backgroundJobs)
    .set({
      leaseExpiresAt: sql`timezone('UTC', clock_timestamp()) - interval '1 second'`,
    })
    .where(eq(backgroundJobs.id, backgroundId));
  const reclaimed = await claimBackgroundJob(
    db,
    { jobId: backgroundId, kind: "clerk-user-deletion", handlerVersion: 1 },
    context.signal,
  );
  expect(reclaimed?.leaseId).not.toBe(first.leaseId);
  if (!reclaimed) {
    throw new Error("Missing reclaimed background lease");
  }
  await expect(
    captureUserErasureWork(db, reclaimed, context.signal),
  ).rejects.toThrow("account_erasure:required_capture_missing:remote");
  const [resumed] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(resumed?.id).toBe(captured?.id);
  expect(resumed?.captureRevision).toBe(captured?.captureRevision);
});

test("durable user.deleted worker retries an incomplete B1 capture without advancing cleanup", async () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  onTestFinished(async () => {
    await pool.end();
  });
  const db = drizzle(pool);
  const userId = `synthetic_deleted_${randomUUID()}`;
  const jobId = await createStore().set(
    enqueueClerkUserDeletion$,
    userId,
    context.signal,
  );
  const first = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(first.processed).toBe(1);
  const [retry] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(retry).toMatchObject({
    status: "pending",
    failureCount: 1,
    checkpoint: {},
    lastError: "account_erasure:required_capture_missing:remote",
  });
  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(captured?.sealedCaptureRevision).toBeNull();
  expect(captured?.captureRevision).toBe(2);

  await db
    .update(backgroundJobs)
    .set({ availableAt: sql`timezone('UTC', clock_timestamp())` })
    .where(eq(backgroundJobs.id, jobId));
  const replay = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(replay.processed).toBe(1);
  const [retried] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(retried?.failureCount).toBe(2);
  const [sameCapture] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(sameCapture?.id).toBe(captured?.id);
  expect(sameCapture?.captureRevision).toBe(2);
});

test("durable user.deleted worker resumes the same capture after an external object failure", async () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  onTestFinished(async () => {
    await pool.end();
  });
  const db = drizzle(pool);
  const userId = `synthetic_deleted_${randomUUID()}`;
  const fileId = randomUUID();
  await pool.query(
    "INSERT INTO run_uploaded_files (id, source, external_id, user_id, storage_key, metadata) VALUES ($1, 'web', $2, $3, $4, '{}'::jsonb)",
    [fileId, fileId, userId, `artifacts/${fileId}`],
  );
  const jobId = await createStore().set(
    enqueueClerkUserDeletion$,
    userId,
    context.signal,
  );
  context.mocks.s3.send.mockRejectedValue(
    new Error("transient object failure"),
  );
  const first = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(first.processed).toBe(1);
  const [retry] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(retry?.status).toBe("pending");
  expect(retry?.lastError).toContain("transient object failure");
  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(captured?.sealedCaptureRevision).toBeNull();

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof Object &&
      command.constructor.name === "HeadObjectCommand"
    ) {
      return Promise.reject(
        Object.assign(new Error("Object absent"), { name: "NoSuchKey" }),
      );
    }
    return Promise.resolve({ Contents: [] });
  });
  await db
    .update(backgroundJobs)
    .set({ availableAt: sql`timezone('UTC', clock_timestamp())` })
    .where(eq(backgroundJobs.id, jobId));
  const replay = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(replay.processed).toBe(1);
  const [sameCapture] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(sameCapture?.id).toBe(captured?.id);
  expect(sameCapture?.captureRevision).toBe(2);
  const [failedParent] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(failedParent?.status).toBe("pending");
  expect(failedParent?.lastError).toBeNull();
  expect(failedParent?.checkpoint).toMatchObject({ phase: "capture" });
  // The failed B1 item still owns its independent lease. A restarted worker
  // waits for that lease to expire, then resumes its durable cursor.
  await db
    .update(accountErasureWork)
    .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(
      and(
        eq(accountErasureWork.jobId, captured?.id ?? ""),
        isNotNull(accountErasureWork.leaseId),
      ),
    );
  await db
    .update(backgroundJobs)
    .set({ availableAt: sql`timezone('UTC', clock_timestamp())` })
    .where(eq(backgroundJobs.id, jobId));
  const afterLeaseLoss = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(afterLeaseLoss.processed).toBe(1);
  const [stillRetryable] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(stillRetryable?.lastError).toBe(
    "account_erasure:required_capture_missing:remote",
  );
});

test("pre-upgrade deletion tasks with unknown legacy progress stay retryable", async () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  onTestFinished(async () => {
    await pool.end();
  });
  const db = drizzle(pool);
  const userId = `synthetic_deleted_${randomUUID()}`;
  const jobId = randomUUID();
  await enqueueBackgroundJob(
    db,
    {
      id: jobId,
      kind: "clerk-user-deletion",
      handlerVersion: 1,
      userId,
      orgId: "",
      input: {},
      checkpoint: {},
    },
    context.signal,
  );
  const result = await createStore().set(
    executeClerkUserDeletionWork$,
    { jobId },
    context.signal,
  );
  expect(result.processed).toBe(1);
  const [task] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(task?.status).toBe("pending");
  expect(task?.lastError).toBe("account_erasure:legacy_job_capture_unproven");
  const [capture] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(capture).toBeUndefined();
});
