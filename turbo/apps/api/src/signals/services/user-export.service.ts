import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  notExists,
  sql,
} from "drizzle-orm";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { backgroundJobDatabaseNow } from "./background-job.service";
import type {
  UserExportJob,
  UserExportStartResponse,
  UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import { exportJobs } from "@okouai/db/schema/export-job";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { userCache } from "@okouai/db/schema/user-cache";
import { env } from "../../lib/env";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate } from "../../lib/time";
import {
  pgBooleanDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";
import { buildFromAddress } from "./email-common.service";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const DATA_EXPORT_FILENAME = "okou-data-export.zip";

type ExportJobStatus = UserExportJob["status"];
type ActiveExportJobStatus = Extract<ExportJobStatus, "pending" | "running">;

interface StartUserExportArgs {
  readonly userId: string;
  readonly orgId: string;
}

type StartUserExportResult =
  | {
      readonly kind: "accepted";
      readonly jobId: string;
      readonly status: ActiveExportJobStatus;
      readonly shouldExecute: boolean;
    }
  | { readonly kind: "rate_limited" };

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkEmailProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}

const EXPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const satisfies readonly ExportJobStatus[];

const ACTIVE_EXPORT_JOB_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly ActiveExportJobStatus[];

function isExportJobStatus(status: string): status is ExportJobStatus {
  return EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function exportJobStatus(status: string): ExportJobStatus {
  if (isExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected export job status: ${status}`);
}

function isActiveExportJobStatus(
  status: string,
): status is ActiveExportJobStatus {
  return ACTIVE_EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function activeExportJobStatus(status: string): ActiveExportJobStatus {
  if (isActiveExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected active export job status: ${status}`);
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

function displayName(user: ClerkEmailProfile): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

export function userExportStatus(userId: string) {
  return computed(async (get): Promise<UserExportStatusResponse> => {
    const db = get(db$);
    const [latestJob] = await db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        expiresAt: exportJobs.expiresAt,
        s3Key: exportJobs.s3Key,
        error: exportJobs.error,
      })
      .from(exportJobs)
      .where(eq(exportJobs.userId, userId))
      .orderBy(desc(exportJobs.createdAt))
      .limit(1);

    const now = nowDate();
    const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_MS);
    const [recentCompleted] = await db
      .select({ completedAt: exportJobs.completedAt })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          eq(exportJobs.status, "completed"),
          gt(exportJobs.completedAt, rateLimitCutoff),
        ),
      )
      .limit(1);

    const [activeJob] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    const hasActiveJob = Boolean(activeJob);
    const canExport = !recentCompleted && !hasActiveJob;
    const nextExportAt = recentCompleted?.completedAt
      ? new Date(
          recentCompleted.completedAt.getTime() + RATE_LIMIT_MS,
        ).toISOString()
      : null;

    if (!latestJob) {
      return { job: null, canExport: true, nextExportAt: null };
    }

    let downloadUrl: string | null = null;
    if (
      latestJob.status === "completed" &&
      latestJob.s3Key &&
      latestJob.expiresAt &&
      latestJob.expiresAt > now
    ) {
      downloadUrl = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          latestJob.s3Key,
          DATA_EXPORT_FILENAME,
          true,
        ),
      );
    }

    return {
      job: {
        id: latestJob.id,
        status: exportJobStatus(latestJob.status),
        createdAt: latestJob.createdAt.toISOString(),
        completedAt: latestJob.completedAt?.toISOString() ?? null,
        expiresAt: latestJob.expiresAt?.toISOString() ?? null,
        downloadUrl,
        error: latestJob.error,
      },
      canExport,
      nextExportAt,
    };
  });
}

function exportJobAdmissionValues(
  args: StartUserExportArgs,
  jobId: string,
  at: Date,
) {
  return {
    id: sql`${jobId}::uuid`.mapWith(exportJobs.id).as("id"),
    userId: sql`${args.userId}`.mapWith(exportJobs.userId).as("user_id"),
    orgId: sql`${args.orgId}`.mapWith(exportJobs.orgId).as("org_id"),
    status: sql`'pending'`.mapWith(exportJobs.status).as("status"),
    executionMode: sql`'durable-v1'`
      .mapWith(exportJobs.executionMode)
      .as("execution_mode"),
    s3Key: sql`null::text`
      .mapWith(nullableDriverValueDecoder(exportJobs.s3Key))
      .as("s3_key"),
    artifactUrls: sql`null::jsonb`
      .mapWith(nullableDriverValueDecoder(exportJobs.artifactUrls))
      .as("artifact_urls"),
    error: sql`null::text`
      .mapWith(nullableDriverValueDecoder(exportJobs.error))
      .as("error"),
    expiresAt: sql`null::timestamp`
      .mapWith(nullableDriverValueDecoder(exportJobs.expiresAt))
      .as("expires_at"),
    createdAt: sql`${sql.param(at, exportJobs.createdAt)}::timestamp`
      .mapWith(exportJobs.createdAt)
      .as("created_at"),
    completedAt: sql`null::timestamp`
      .mapWith(nullableDriverValueDecoder(exportJobs.completedAt))
      .as("completed_at"),
  };
}

function exportBackgroundJobValues(args: StartUserExportArgs) {
  return {
    id: sql`claimed_export_job.id`.mapWith(backgroundJobs.id).as("id"),
    kind: sql`'user-export'`.mapWith(backgroundJobs.kind).as("kind"),
    handlerVersion: sql`1`
      .mapWith(backgroundJobs.handlerVersion)
      .as("handler_version"),
    userId: sql`${sql.param(args.userId, backgroundJobs.userId)}::text`
      .mapWith(backgroundJobs.userId)
      .as("user_id"),
    orgId: sql`${sql.param(args.orgId, backgroundJobs.orgId)}::text`
      .mapWith(backgroundJobs.orgId)
      .as("org_id"),
    input: sql`${sql.param({}, backgroundJobs.input)}::jsonb`
      .mapWith(backgroundJobs.input)
      .as("input"),
    checkpoint: sql`${sql.param({}, backgroundJobs.checkpoint)}::jsonb`
      .mapWith(backgroundJobs.checkpoint)
      .as("checkpoint"),
    status: sql`'pending'`.mapWith(backgroundJobs.status).as("status"),
    availableAt: sql`${backgroundJobDatabaseNow}`
      .mapWith(backgroundJobs.availableAt)
      .as("available_at"),
    leaseId: sql`null::uuid`
      .mapWith(nullableDriverValueDecoder(backgroundJobs.leaseId))
      .as("lease_id"),
    leaseExpiresAt: sql`null::timestamp`
      .mapWith(nullableDriverValueDecoder(backgroundJobs.leaseExpiresAt))
      .as("lease_expires_at"),
    failureCount: sql`0`
      .mapWith(backgroundJobs.failureCount)
      .as("failure_count"),
    lastError: sql`null::text`
      .mapWith(nullableDriverValueDecoder(backgroundJobs.lastError))
      .as("last_error"),
    createdAt: sql`${backgroundJobDatabaseNow}`
      .mapWith(backgroundJobs.createdAt)
      .as("created_at"),
    updatedAt: sql`${backgroundJobDatabaseNow}`
      .mapWith(backgroundJobs.updatedAt)
      .as("updated_at"),
    completedAt: sql`null::timestamp`
      .mapWith(nullableDriverValueDecoder(backgroundJobs.completedAt))
      .as("completed_at"),
  };
}

export const startUserExport$ = command(
  async (
    { set },
    args: StartUserExportArgs,
    signal: AbortSignal,
  ): Promise<StartUserExportResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const jobId = randomUUID();
    const at = nowDate();
    const active = db.$with("active_export_job").as(
      db
        .select({ id: exportJobs.id, status: exportJobs.status })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.userId, args.userId),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        )
        .limit(1),
    );
    const recent = db.$with("recent_export_job").as(
      db
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.userId, args.userId),
            eq(exportJobs.status, "completed"),
            gt(exportJobs.completedAt, new Date(at.getTime() - RATE_LIMIT_MS)),
          ),
        )
        .limit(1),
    );
    const claimed = db.$with("claimed_export_job").as(
      db
        .insert(exportJobs)
        .select(
          db
            .select(exportJobAdmissionValues(args, jobId, at))
            .from(sql`(select 1) as export_admission`)
            .where(
              and(
                notExists(db.select().from(active)),
                notExists(db.select().from(recent)),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: exportJobs.userId,
          targetWhere: sql`${exportJobs.status} IN ('pending', 'running')`,
          set: { id: sql`${exportJobs.id}` },
        })
        .returning({ id: exportJobs.id, status: exportJobs.status }),
    );
    const scheduled = db.$with("scheduled_export_job").as(
      db
        .insert(backgroundJobs)
        .select(
          db
            .select(exportBackgroundJobValues(args))
            .from(claimed)
            .where(eq(claimed.id, jobId)),
        )
        .returning({ id: backgroundJobs.id }),
    );
    // Cooldown and already-active ownership use this statement's snapshot.
    // The unique index also returns an active owner that wins after that snapshot.
    // A completion during that wait is considered by the next request.
    const admittedJobs = db
      .select({
        id: claimed.id,
        status: claimed.status,
        shouldExecute: exists(db.select().from(scheduled))
          .mapWith(pgBooleanDecoder)
          .as("should_execute"),
      })
      .from(claimed)
      .unionAll(
        db
          .select({
            id: active.id,
            status: active.status,
            shouldExecute: sql`false`
              .mapWith(pgBooleanDecoder)
              .as("should_execute"),
          })
          .from(active),
      )
      .as("admitted_export_jobs");
    const [admitted] = await db
      .with(active, recent, claimed, scheduled)
      .select()
      .from(admittedJobs);
    signal.throwIfAborted();
    if (!admitted) {
      return { kind: "rate_limited" };
    }
    return {
      kind: "accepted",
      jobId: admitted.id,
      status: activeExportJobStatus(admitted.status),
      shouldExecute: admitted.shouldExecute,
    };
  },
);

const getCachedUserEmail$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [cached] = await db
      .select({ email: userCache.email, cachedAt: userCache.cachedAt })
      .from(userCache)
      .where(eq(userCache.userId, userId))
      .limit(1);
    signal.throwIfAborted();

    if (
      cached &&
      nowDate().getTime() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS
    ) {
      return cached.email;
    }

    const client = get(clerk$);
    const user = await findClerkUser(client, userId, signal);
    signal.throwIfAborted();
    if (!user) {
      throw new Error(`No Clerk user found for user ${userId}`);
    }

    const email = primaryEmail(user);
    if (!email) {
      throw new Error(`No primary email found for user ${userId}`);
    }

    await db
      .insert(userCache)
      .values({
        userId,
        email,
        name: displayName(user),
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: {
          email,
          name: displayName(user),
          imageUrl: user.imageUrl ?? null,
          cachedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    return email;
  },
);

export const userExportReadyEmail$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly downloadUrl: string;
      readonly expiresAt: Date;
      readonly artifactCount: number;
    },
    signal: AbortSignal,
  ): Promise<typeof emailOutbox.$inferInsert> => {
    const email = await set(getCachedUserEmail$, args.userId, signal);
    signal.throwIfAborted();
    const formattedExpiry = args.expiresAt.toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });

    return {
      fromAddress: buildFromAddress(),
      toAddresses: email,
      subject: DATA_EXPORT_READY_SUBJECT,
      template: {
        template: "data-export-ready",
        props: {
          downloadUrl: args.downloadUrl,
          expiresAt: formattedExpiry,
          artifactCount: args.artifactCount,
        },
      },
      status: "pending",
      attempts: 0,
    };
  },
);

function exportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return { jobId: result.jobId, status: result.status };
}

export function toUserExportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return exportStartResponse(result);
}
