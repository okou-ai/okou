import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { BackgroundJobData } from "@okouai/db/jsonb-contracts/background-job";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { ApiDb, Tx } from "../../lib/db-types";

export const BACKGROUND_JOB_LEASE_MS = 60_000;

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type ClaimedBackgroundJob = BackgroundJob & {
  readonly leaseId: string;
  readonly leaseExpiresAt: Date;
};

type JobDatabase = ApiDb | Tx;

interface EnqueueBackgroundJobArgs {
  readonly id: string;
  readonly kind: string;
  readonly handlerVersion: number;
  readonly userId: string;
  readonly orgId: string;
  readonly input: BackgroundJobData;
  readonly checkpoint?: BackgroundJobData;
}

/**
 * Safe to repeat after a lost commit receipt. An ID can never be reused for a
 * different handler, owner, or input, and replay never resets durable progress.
 */
export async function enqueueBackgroundJob(
  db: JobDatabase,
  args: EnqueueBackgroundJobArgs,
  signal: AbortSignal,
): Promise<BackgroundJob> {
  signal.throwIfAborted();
  const [inserted] = await db
    .insert(backgroundJobs)
    .values({
      ...args,
      availableAt: databaseNow,
      createdAt: databaseNow,
      updatedAt: databaseNow,
    })
    .onConflictDoNothing({ target: backgroundJobs.id })
    .returning();
  signal.throwIfAborted();
  if (inserted) {
    return inserted;
  }
  const [existing] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, args.id))
    .limit(1);
  signal.throwIfAborted();
  if (
    !existing ||
    existing.kind !== args.kind ||
    existing.handlerVersion !== args.handlerVersion ||
    existing.userId !== args.userId ||
    existing.orgId !== args.orgId ||
    !isDeepStrictEqual(existing.input, args.input)
  ) {
    throw new Error("Background job identity conflicts with its durable input");
  }
  return existing;
}

interface ClaimBackgroundJobArgs {
  readonly jobId?: string;
  readonly kind: string;
  readonly handlerVersion: number;
}

// Persisted timestamps are UTC wall-clock values. Using the database clock
// prevents a stale process clock from extending authority after lease expiry.
const databaseNow = sql`timezone('UTC', clock_timestamp())`;

/** Claim exactly one compatible job without waiting on another claimant. */
export async function claimBackgroundJob(
  db: JobDatabase,
  args: ClaimBackgroundJobArgs,
  signal: AbortSignal,
): Promise<ClaimedBackgroundJob | null> {
  signal.throwIfAborted();
  return await db.transaction(async (tx) => {
    signal.throwIfAborted();
    const [candidate] = await tx
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.kind, args.kind),
          eq(backgroundJobs.handlerVersion, args.handlerVersion),
          args.jobId === undefined
            ? undefined
            : eq(backgroundJobs.id, args.jobId),
          lte(backgroundJobs.availableAt, databaseNow),
          or(
            eq(backgroundJobs.status, "pending"),
            and(
              eq(backgroundJobs.status, "running"),
              lte(backgroundJobs.leaseExpiresAt, databaseNow),
            ),
          ),
        ),
      )
      .orderBy(asc(backgroundJobs.availableAt), asc(backgroundJobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    const leaseId = randomUUID();
    const [claimed] = await tx
      .update(backgroundJobs)
      .set({
        status: "running",
        leaseId,
        leaseExpiresAt: sql`${databaseNow} + ${BACKGROUND_JOB_LEASE_MS} * interval '1 millisecond'`,
        updatedAt: databaseNow,
      })
      .where(eq(backgroundJobs.id, candidate.id))
      .returning();
    signal.throwIfAborted();
    if (!claimed?.leaseExpiresAt) {
      throw new Error("Background job claim did not retain its lease");
    }
    return { ...claimed, leaseId, leaseExpiresAt: claimed.leaseExpiresAt };
  });
}

function activeLease(job: ClaimedBackgroundJob) {
  return and(
    eq(backgroundJobs.id, job.id),
    eq(backgroundJobs.kind, job.kind),
    eq(backgroundJobs.handlerVersion, job.handlerVersion),
    eq(backgroundJobs.status, "running"),
    eq(backgroundJobs.leaseId, job.leaseId),
    gt(backgroundJobs.leaseExpiresAt, databaseNow),
  );
}

async function updateLeasedJob(
  db: JobDatabase,
  args: {
    readonly job: ClaimedBackgroundJob;
    readonly values: PgUpdateSetSource<typeof backgroundJobs>;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  return await db.transaction(async (tx) => {
    // Take the row lock before evaluating wall-clock expiry for the mutation.
    // A direct UPDATE can evaluate its clock condition before waiting on a row
    // lock and resume after that deadline without a competing tuple change.
    const [locked] = await tx
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(activeLease(args.job))
      .limit(1)
      .for("update", { skipLocked: true });
    signal.throwIfAborted();
    if (!locked) {
      return false;
    }
    const [updated] = await tx
      .update(backgroundJobs)
      .set({ ...args.values, updatedAt: databaseNow })
      .where(activeLease(args.job))
      .returning({ id: backgroundJobs.id });
    signal.throwIfAborted();
    return updated !== undefined;
  });
}

interface CheckpointBackgroundJobArgs {
  readonly job: ClaimedBackgroundJob;
  readonly checkpoint: BackgroundJobData;
}

/** Commit progress without extending the invocation's bounded lease. */
export async function checkpointBackgroundJob(
  db: JobDatabase,
  args: CheckpointBackgroundJobArgs,
  signal: AbortSignal,
): Promise<boolean> {
  return await updateLeasedJob(
    db,
    {
      job: args.job,
      values: {
        checkpoint: args.checkpoint,
        failureCount: 0,
        lastError: null,
      },
    },
    signal,
  );
}

interface YieldBackgroundJobArgs extends CheckpointBackgroundJobArgs {
  readonly availableAt?: Date;
}

/** Normal continuation is progress, not a failure or a retry attempt. */
export async function yieldBackgroundJob(
  db: JobDatabase,
  args: YieldBackgroundJobArgs,
  signal: AbortSignal,
): Promise<boolean> {
  return await updateLeasedJob(
    db,
    {
      job: args.job,
      values: {
        status: "pending",
        checkpoint: args.checkpoint,
        failureCount: 0,
        lastError: null,
        availableAt: args.availableAt ?? databaseNow,
        leaseId: null,
        leaseExpiresAt: null,
      },
    },
    signal,
  );
}

interface RetryBackgroundJobArgs {
  readonly job: ClaimedBackgroundJob;
  readonly error: string;
  readonly availableAt: Date;
}

/** Keep the last committed checkpoint when an attempt fails. */
export async function retryBackgroundJob(
  db: JobDatabase,
  args: RetryBackgroundJobArgs,
  signal: AbortSignal,
): Promise<boolean> {
  return await updateLeasedJob(
    db,
    {
      job: args.job,
      values: {
        status: "pending",
        failureCount: sql`${backgroundJobs.failureCount} + 1`,
        lastError: args.error.slice(0, 4096),
        availableAt: args.availableAt,
        leaseId: null,
        leaseExpiresAt: null,
      },
    },
    signal,
  );
}

/** Call inside the result-publication transaction when completion has effects. */
export async function completeBackgroundJob(
  db: JobDatabase,
  args: {
    readonly job: ClaimedBackgroundJob;
    /** Optional terminal result committed atomically with completion. */
    readonly checkpoint?: BackgroundJobData;
  },
  signal: AbortSignal,
): Promise<boolean> {
  return await updateLeasedJob(
    db,
    {
      job: args.job,
      values: {
        status: "completed",
        ...(args.checkpoint === undefined
          ? {}
          : { checkpoint: args.checkpoint }),
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: databaseNow,
      },
    },
    signal,
  );
}

export async function failBackgroundJob(
  db: JobDatabase,
  args: { readonly job: ClaimedBackgroundJob; readonly error: string },
  signal: AbortSignal,
): Promise<boolean> {
  return await updateLeasedJob(
    db,
    {
      job: args.job,
      values: {
        status: "failed",
        failureCount: sql`${backgroundJobs.failureCount} + 1`,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: args.error.slice(0, 4096),
        completedAt: databaseNow,
      },
    },
    signal,
  );
}
