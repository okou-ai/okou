import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackgroundJobData } from "@okouai/db/jsonb-contracts/background-job";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { command } from "ccstate";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
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

/**
 * Claim exactly one compatible job with one conditional UPDATE.
 *
 * The bounded candidate subquery picks the oldest claimable row; the outer
 * predicate re-checks claimability against the current row version, so two
 * workers racing for the same candidate cannot both win. The loser gets `null`
 * (nothing claimed this round) instead of waiting for or skipping a row lock.
 */
export const claimBackgroundJob$ = command(
  async (
    { set },
    args: ClaimBackgroundJobArgs,
    signal: AbortSignal,
  ): Promise<ClaimedBackgroundJob | null> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const claimable = and(
      eq(backgroundJobs.kind, args.kind),
      eq(backgroundJobs.handlerVersion, args.handlerVersion),
      args.jobId === undefined ? undefined : eq(backgroundJobs.id, args.jobId),
      lte(backgroundJobs.availableAt, databaseNow),
      or(
        eq(backgroundJobs.status, "pending"),
        and(
          eq(backgroundJobs.status, "running"),
          lte(backgroundJobs.leaseExpiresAt, databaseNow),
        ),
      ),
    );
    const candidate = db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(claimable)
      .orderBy(asc(backgroundJobs.availableAt), asc(backgroundJobs.id))
      .limit(1);
    const leaseId = randomUUID();
    const [claimed] = await db
      .update(backgroundJobs)
      .set({
        status: "running",
        leaseId,
        leaseExpiresAt: sql`${databaseNow} + ${BACKGROUND_JOB_LEASE_MS} * interval '1 millisecond'`,
        updatedAt: databaseNow,
      })
      .where(and(inArray(backgroundJobs.id, candidate), claimable))
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

/**
 * Commit one existing job's business transition under its current lease.
 *
 * One conditional UPDATE: the lease predicate (including the wall-clock expiry)
 * is evaluated against the current row version, so a lost or expired lease
 * returns `false` without a separate row lock.
 */
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
    const [updated] = await db
      .update(backgroundJobs)
      .set({ ...values, updatedAt: databaseNow })
      .where(activeLease(job))
      .returning({ id: backgroundJobs.id });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);
