import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackgroundJobData } from "@okouai/db/jsonb-contracts/background-job";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { command } from "ccstate";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";
import {
  BACKGROUND_JOB_LEASE_MS,
  type BackgroundJob,
  type ClaimedBackgroundJob,
} from "./background-job.service";

const databaseNow = sql`timezone('UTC', clock_timestamp())`;

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

/** Claim exactly one compatible job without waiting on another claimant. */
export const claimBackgroundJob$ = command(
  async (
    { set },
    args: ClaimBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<ClaimedBackgroundJob | null> => {
    const db = set(writeDb$);
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
  },
);

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

type BackgroundJobTransition =
  | { readonly kind: "checkpoint"; readonly checkpoint: BackgroundJobData }
  | { readonly kind: "complete"; readonly checkpoint: BackgroundJobData }
  | {
      readonly kind: "retry";
      readonly error: string;
      readonly availableAt: Date;
    }
  | { readonly kind: "fail"; readonly error: string };

function transitionValues(
  transition: BackgroundJobTransition,
): PgUpdateSetSource<typeof backgroundJobs> {
  switch (transition.kind) {
    case "checkpoint": {
      return {
        checkpoint: transition.checkpoint,
        failureCount: 0,
        lastError: null,
      };
    }
    case "complete": {
      return {
        status: "completed",
        checkpoint: transition.checkpoint,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: databaseNow,
      };
    }
    case "retry": {
      return {
        status: "pending",
        failureCount: sql`${backgroundJobs.failureCount} + 1`,
        lastError: transition.error.slice(0, 4096),
        availableAt: transition.availableAt,
        leaseId: null,
        leaseExpiresAt: null,
      };
    }
    case "fail": {
      return {
        status: "failed",
        failureCount: sql`${backgroundJobs.failureCount} + 1`,
        lastError: transition.error.slice(0, 4096),
        leaseId: null,
        leaseExpiresAt: null,
        completedAt: databaseNow,
      };
    }
  }
}

/** Commit one existing job's business transition under its current lease. */
export const transitionBackgroundJob$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    transition: BackgroundJobTransition,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const values = transitionValues(transition);
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      // Acquire this one row before the final wall-clock expiry check. No worker
      // work, external I/O, or handle-bearing helper runs in this transaction.
      const [locked] = await tx
        .select({ id: backgroundJobs.id })
        .from(backgroundJobs)
        .where(activeLease(job))
        .limit(1)
        .for("update", { skipLocked: true });
      signal.throwIfAborted();
      if (!locked) {
        return false;
      }
      const [updated] = await tx
        .update(backgroundJobs)
        .set({ ...values, updatedAt: databaseNow })
        .where(activeLease(job))
        .returning({ id: backgroundJobs.id });
      signal.throwIfAborted();
      return updated !== undefined;
    });
  },
);
