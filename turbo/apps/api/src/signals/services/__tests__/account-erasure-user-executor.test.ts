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
import { vncCredentials } from "@okouai/db/schema/vnc-credential";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import {
  claimBackgroundJob,
  enqueueBackgroundJob,
} from "../background-job.service";
import { accountErasureStatus } from "../account-erasure-status.service";
import { captureUserErasureWork } from "../account-erasure-user-executor";
import {
  enqueueClerkUserDeletion$,
  executeClerkUserDeletionWork$,
} from "../clerk-user-deletion-job.service";

// Capture revisions, work leases and residual work have no account-facing
// route. This integration test crosses the DB boundary to prove the durable
// state the signed webhook worker must resume after a process restart.
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
  ).resolves.toBeTruthy();

  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(captured?.captureRevision).toBe(2);
  expect(captured?.sealedCaptureRevision).toBe(2);
  const sinks = await db
    .select()
    .from(accountErasureSinks)
    .where(eq(accountErasureSinks.jobId, captured?.id ?? ""));
  expect(sinks).toHaveLength(14);
  const inventory = await db
    .select()
    .from(accountErasureWork)
    .where(eq(accountErasureWork.jobId, captured?.id ?? ""));
  expect(
    inventory.filter((item) => {
      return item.kind === "inventory";
    }),
  ).toHaveLength(14);
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
  ).resolves.toBeTruthy();
  const [resumed] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(resumed?.id).toBe(captured?.id);
  expect(resumed?.captureRevision).toBe(captured?.captureRevision);
});

async function runDeletionTask(db: ReturnType<typeof drizzle>, jobId: string) {
  // Each invocation owns one phase budget; make the yielded task due again.
  await db
    .update(backgroundJobs)
    .set({ availableAt: sql`timezone('UTC', clock_timestamp())` })
    .where(eq(backgroundJobs.id, jobId));
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
  return task;
}

test("durable user.deleted worker cleans up after capture and finalizes on the next invocation", async () => {
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
  const cleaned = await runDeletionTask(db, jobId);
  expect(cleaned).toMatchObject({
    status: "pending",
    lastError: null,
    checkpoint: { phase: "verify" },
  });
  const finished = await runDeletionTask(db, jobId);
  expect(finished).toMatchObject({ status: "completed", lastError: null });
  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(captured?.sealedCaptureRevision).toBe(captured?.captureRevision);
  expect(captured?.state).toBe("verified_no_applicable_data");
  await expect(accountErasureStatus(db, userId)).resolves.toBe("complete");
});

test("durable user.deleted worker completes with unresolved residuals still reported pending", async () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  onTestFinished(async () => {
    await pool.end();
  });
  const db = drizzle(pool);
  const userId = `synthetic_deleted_${randomUUID()}`;
  // No direct VNC provider can prove a per-user disconnect, so this credential
  // always leaves a capability residual after its row is removed.
  await db.insert(vncCredentials).values({
    orgId: `org_${randomUUID()}`,
    userId,
    name: "VNC secret",
    authMethod: "vnc_password",
    encryptedPassword: "encrypted-vnc-canary",
  });
  const jobId = await createStore().set(
    enqueueClerkUserDeletion$,
    userId,
    context.signal,
  );
  let task = await runDeletionTask(db, jobId);
  for (let attempt = 0; attempt < 5 && task?.status === "pending"; attempt++) {
    task = await runDeletionTask(db, jobId);
  }
  expect(task).toMatchObject({ status: "completed", lastError: null });
  await expect(
    db.select().from(vncCredentials).where(eq(vncCredentials.userId, userId)),
  ).resolves.toStrictEqual([]);
  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  const residuals = await db
    .select({ id: accountErasureWork.id })
    .from(accountErasureWork)
    .where(
      and(
        eq(accountErasureWork.jobId, captured?.id ?? ""),
        eq(accountErasureWork.state, "capability_unresolved"),
      ),
    );
  expect(residuals.length).toBeGreaterThan(0);
  await expect(accountErasureStatus(db, userId)).resolves.toBe("pending");
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
  // The failed B1 item still owns its independent lease, so this replay
  // cannot seal the capture yet.
  const [waiting] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  expect(waiting?.status).toBe("pending");
  expect(waiting?.checkpoint).toMatchObject({ phase: "capture" });

  // A restarted worker waits for that lease to expire, then resumes its
  // durable cursor and continues past capture.
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
  const [finished] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, jobId));
  // Capture sealed and the legacy cleanup ran; verification runs next.
  expect(finished?.checkpoint).toMatchObject({ phase: "verify" });
  const [sameCapture] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(sameCapture?.id).toBe(captured?.id);
  expect(sameCapture?.sealedCaptureRevision).toBe(sameCapture?.captureRevision);
});

test("pre-upgrade deletion tasks without a phase capture before cleanup", async () => {
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
  expect(task).toMatchObject({
    status: "pending",
    lastError: null,
    checkpoint: { phase: "verify" },
  });
  const [capture] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  expect(capture?.sealedCaptureRevision).toBe(capture?.captureRevision);
});
