import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { BackgroundJobData } from "@okouai/db/jsonb-contracts/background-job";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

export const BACKGROUND_JOB_LEASE_MS = 60_000;

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type ClaimedBackgroundJob = BackgroundJob & {
  readonly leaseId: string;
  readonly leaseExpiresAt: Date;
};

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
export const enqueueBackgroundJob$ = command(
  async (
    { set },
    args: EnqueueBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<BackgroundJob> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [inserted] = await db
      .insert(backgroundJobs)
      .values({
        ...args,
        availableAt: backgroundJobDatabaseNow,
        createdAt: backgroundJobDatabaseNow,
        updatedAt: backgroundJobDatabaseNow,
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
      throw new Error(
        "Background job identity conflicts with its durable input",
      );
    }
    return existing;
  },
);

interface ClaimBackgroundJobArgs {
  readonly jobId?: string;
  readonly kind: string;
  readonly handlerVersion: number;
}

// Persisted timestamps are UTC wall-clock values. Using the database clock
// prevents a stale process clock from extending authority after lease expiry.
export const backgroundJobDatabaseNow = sql`timezone('UTC', clock_timestamp())`;

/** Claim exactly one compatible job without waiting on another claimant. */
export const claimBackgroundJob$ = command(
  async (
    { set },
    args: ClaimBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<ClaimedBackgroundJob | null> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const candidate = db.$with("background_job_candidate").as(
      db
        .select({ id: backgroundJobs.id })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.kind, args.kind),
            eq(backgroundJobs.handlerVersion, args.handlerVersion),
            args.jobId === undefined
              ? undefined
              : eq(backgroundJobs.id, args.jobId),
            lte(backgroundJobs.availableAt, backgroundJobDatabaseNow),
            or(
              eq(backgroundJobs.status, "pending"),
              and(
                eq(backgroundJobs.status, "running"),
                lte(backgroundJobs.leaseExpiresAt, backgroundJobDatabaseNow),
              ),
            ),
          ),
        )
        .orderBy(asc(backgroundJobs.availableAt), asc(backgroundJobs.id))
        .limit(1)
        .for("update", { skipLocked: true }),
    );
    const leaseId = randomUUID();
    const [claimed] = await db
      .with(candidate)
      .update(backgroundJobs)
      .set({
        status: "running",
        leaseId,
        leaseExpiresAt: sql`${backgroundJobDatabaseNow} + ${BACKGROUND_JOB_LEASE_MS} * interval '1 millisecond'`,
        updatedAt: backgroundJobDatabaseNow,
      })
      .where(
        inArray(
          backgroundJobs.id,
          db.select({ id: candidate.id }).from(candidate),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!claimed) {
      return null;
    }
    if (!claimed.leaseExpiresAt) {
      throw new Error("Background job claim did not retain its lease");
    }
    return { ...claimed, leaseId, leaseExpiresAt: claimed.leaseExpiresAt };
  },
);

export function backgroundJobActiveLease(job: ClaimedBackgroundJob) {
  return and(
    eq(backgroundJobs.id, job.id),
    eq(backgroundJobs.kind, job.kind),
    eq(backgroundJobs.handlerVersion, job.handlerVersion),
    eq(backgroundJobs.status, "running"),
    eq(backgroundJobs.leaseId, job.leaseId),
    gt(backgroundJobs.leaseExpiresAt, backgroundJobDatabaseNow),
  );
}

const updateLeasedJob$ = command(
  async (
    { set },
    args: {
      readonly job: ClaimedBackgroundJob;
      readonly values: PgUpdateSetSource<typeof backgroundJobs>;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    signal.throwIfAborted();

    // Take the row lock before evaluating wall-clock expiry for the mutation.
    // A direct UPDATE can evaluate its clock condition before waiting on a row
    // lock and resume after that deadline without a competing tuple change.
    const locked = db
      .$with("background_job_lease")
      .as(
        db
          .select({ id: backgroundJobs.id })
          .from(backgroundJobs)
          .where(backgroundJobActiveLease(args.job))
          .limit(1)
          .for("update", { skipLocked: true }),
      );
    const [updated] = await db
      .with(locked)
      .update(backgroundJobs)
      .set({ ...args.values, updatedAt: backgroundJobDatabaseNow })
      .where(
        and(
          inArray(backgroundJobs.id, db.select({ id: locked.id }).from(locked)),
          backgroundJobActiveLease(args.job),
        ),
      )
      .returning({ id: backgroundJobs.id });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

interface CheckpointBackgroundJobArgs {
  readonly job: ClaimedBackgroundJob;
  readonly checkpoint: BackgroundJobData;
}

/** Commit progress without extending the invocation's bounded lease. */
export const checkpointBackgroundJob$ = command(
  async (
    { set },
    args: CheckpointBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      updateLeasedJob$,
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
  },
);

interface YieldBackgroundJobArgs extends CheckpointBackgroundJobArgs {
  readonly availableAt?: Date;
}

/** Normal continuation is progress, not a failure or a retry attempt. */
export const yieldBackgroundJob$ = command(
  async (
    { set },
    args: YieldBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      updateLeasedJob$,
      {
        job: args.job,
        values: {
          status: "pending",
          checkpoint: args.checkpoint,
          failureCount: 0,
          lastError: null,
          availableAt: args.availableAt ?? backgroundJobDatabaseNow,
          leaseId: null,
          leaseExpiresAt: null,
        },
      },
      signal,
    );
  },
);

interface RetryBackgroundJobArgs {
  readonly job: ClaimedBackgroundJob;
  readonly error: string;
  readonly availableAt: Date;
}

/** Keep the last committed checkpoint when an attempt fails. */
export const retryBackgroundJob$ = command(
  async (
    { set },
    args: RetryBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      updateLeasedJob$,
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
  },
);

/** Complete a leased job; related publication belongs to its owning command. */
export const completeBackgroundJob$ = command(
  async (
    { set },
    args: {
      readonly job: ClaimedBackgroundJob;
      /** Optional terminal result committed atomically with completion. */
      readonly checkpoint?: BackgroundJobData;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      updateLeasedJob$,
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
          completedAt: backgroundJobDatabaseNow,
        },
      },
      signal,
    );
  },
);
