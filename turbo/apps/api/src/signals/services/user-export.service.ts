import { command, computed, type Computed } from "ccstate";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { enqueueBackgroundJob } from "./background-job.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import type {
  UserExportJob,
  UserExportStartResponse,
  UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import { exportJobs } from "@okouai/db/schema/export-job";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { deleteS3Objects, generatePresignedGetUrl } from "../external/s3";
import { nowDate } from "../../lib/time";
import { onRejection } from "../utils";
import {
  UserExportArchive,
  uploadUserExportArchive$,
} from "./user-export-archive.service";
import { collectUserExportData$ } from "./user-export-data.service";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  EMAIL_PUBLIC_BRAND,
} from "./email-common.service";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const EXPORT_DOWNLOAD_EXPIRY_SECONDS = PRESIGNED_URL_TTL_SECONDS;
const EXPORT_DOWNLOAD_EXPIRY_MS = EXPORT_DOWNLOAD_EXPIRY_SECONDS * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const DATA_EXPORT_FILENAME = "okou-data-export.zip";
const EXPORT_CLEANUP_TIMEOUT_MS = 10_000;
const log = logger("service:user-export");

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
      readonly executionMode: "durable-v1" | null;
    }
  | { readonly kind: "rate_limited" };

interface ExecuteUserExportJobArgs {
  readonly jobId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ExportRuntime {
  readonly db: Db;
  readonly bucket: string;
}

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
        executionMode: exportJobs.executionMode,
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

export const startUserExport$ = command(
  async (
    { set },
    args: StartUserExportArgs,
    signal: AbortSignal,
  ): Promise<StartUserExportResult> => {
    const db = set(writeDb$);
    const executionMode = isFeatureEnabled(
      FeatureSwitchKey.DurableUserExport,
      await loadUserFeatureSwitchContext(db, args.orgId, args.userId),
    )
      ? ("durable-v1" as const)
      : null;
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      // Serialize admission and cooldown for this owner, not execution. This also
      // covers a previous job completing while another POST is being admitted.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`user-export:${args.userId}`}, 0))`,
      );
      signal.throwIfAborted();
      const [active] = await tx
        .select({
          id: exportJobs.id,
          status: exportJobs.status,
          executionMode: exportJobs.executionMode,
        })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.userId, args.userId),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (active) {
        return {
          kind: "accepted",
          jobId: active.id,
          status: activeExportJobStatus(active.status),
          executionMode: active.executionMode,
          shouldExecute: false,
        };
      }
      const [recent] = await tx
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.userId, args.userId),
            eq(exportJobs.status, "completed"),
            gt(
              exportJobs.completedAt,
              new Date(nowDate().getTime() - RATE_LIMIT_MS),
            ),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (recent) {
        return { kind: "rate_limited" };
      }
      const [created] = await tx
        .insert(exportJobs)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          status: "pending",
          publicBrand: PUBLIC_BRAND,
          executionMode,
          createdAt: nowDate(),
        })
        .returning({ id: exportJobs.id });
      signal.throwIfAborted();
      if (!created) {
        throw new Error("Failed to create export job");
      }
      if (executionMode) {
        await enqueueBackgroundJob(
          tx,
          {
            id: created.id,
            kind: "user-export",
            handlerVersion: 1,
            userId: args.userId,
            orgId: args.orgId,
            input: {},
          },
          signal,
        );
        signal.throwIfAborted();
      }
      return {
        kind: "accepted",
        jobId: created.id,
        status: "pending",
        executionMode,
        shouldExecute: true,
      };
    });
  },
);

async function isUserUnsubscribed(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.emailUnsubscribed ?? false;
}

function getCachedUserEmail(
  runtime: ExportRuntime,
  userId: string,
  signal: AbortSignal,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const [cached] = await runtime.db
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

    await runtime.db
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
  });
}

export function userExportReadyEmail(
  runtime: ExportRuntime,
  args: {
    readonly userId: string;
    readonly downloadUrl: string;
    readonly expiresAt: Date;
    readonly artifactCount: number;
  },
  signal: AbortSignal,
): Computed<Promise<typeof emailOutbox.$inferInsert | null>> {
  return computed(
    async (get): Promise<typeof emailOutbox.$inferInsert | null> => {
      if (await isUserUnsubscribed(runtime.db, args.userId)) {
        log.debug("export email skipped because user is unsubscribed", {
          userId: args.userId,
        });
        return null;
      }
      signal.throwIfAborted();

      const email = await get(getCachedUserEmail(runtime, args.userId, signal));
      const unsubscribeUrl = buildUnsubscribeUrl(args.userId);
      const oneClickUnsubscribeUrl = buildOneClickUnsubscribeUrl(args.userId);
      const formattedExpiry = args.expiresAt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      return {
        fromAddress: buildFromAddress(),
        toAddresses: email,
        subject: DATA_EXPORT_READY_SUBJECT,
        publicBrand: EMAIL_PUBLIC_BRAND,
        headers: buildUnsubscribeHeaders(oneClickUnsubscribeUrl),
        template: {
          template: "data-export-ready",
          props: {
            downloadUrl: args.downloadUrl,
            expiresAt: formattedExpiry,
            artifactCount: args.artifactCount,
            unsubscribeUrl,
          },
        },
        status: "pending",
        attempts: 0,
      };
    },
  );
}

function enqueueExportReadyEmail(
  runtime: ExportRuntime,
  args: {
    readonly userId: string;
    readonly downloadUrl: string;
    readonly expiresAt: Date;
    readonly artifactCount: number;
  },
  signal: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get) => {
    const email = await get(userExportReadyEmail(runtime, args, signal));
    signal.throwIfAborted();
    if (email) {
      await runtime.db.insert(emailOutbox).values(email);
      signal.throwIfAborted();
    }
  });
}

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

const runExportJob$ = command(async function runExportJob(
  { get, set },
  runtime: ExportRuntime,
  args: ExecuteUserExportJobArgs,
  signal: AbortSignal,
): Promise<void> {
  const [claimed] = await runtime.db
    .update(exportJobs)
    .set({ status: "running" })
    .where(
      and(
        eq(exportJobs.id, args.jobId),
        eq(exportJobs.userId, args.userId),
        eq(exportJobs.orgId, args.orgId),
        eq(exportJobs.status, "pending"),
      ),
    )
    .returning({ id: exportJobs.id });
  signal.throwIfAborted();
  if (!claimed) {
    return;
  }

  const s3Key = `exports/${args.userId}/${args.jobId}.zip`;
  const archive = new UserExportArchive();
  await set(
    uploadUserExportArchive$,
    {
      bucket: runtime.bucket,
      key: s3Key,
      archive,
      writing: set(
        collectUserExportData$,
        runtime,
        { userId: args.userId, requestOrgId: args.orgId },
        archive,
        signal,
      ),
    },
    signal,
  );
  const expiresAt = new Date(nowDate().getTime() + EXPORT_DOWNLOAD_EXPIRY_MS);

  const downloadUrl = await get(
    generatePresignedGetUrl(runtime.bucket, s3Key, DATA_EXPORT_FILENAME, true),
  );
  signal.throwIfAborted();

  const [completed] = await runtime.db
    .update(exportJobs)
    .set({
      status: "completed",
      s3Key,
      artifactUrls: null,
      completedAt: nowDate(),
      expiresAt,
    })
    .where(
      and(
        eq(exportJobs.id, args.jobId),
        eq(exportJobs.userId, args.userId),
        eq(exportJobs.orgId, args.orgId),
        eq(exportJobs.status, "running"),
      ),
    )
    .returning({ id: exportJobs.id });
  signal.throwIfAborted();
  if (!completed) {
    await get(
      deleteS3Objects(
        runtime.bucket,
        [s3Key],
        AbortSignal.timeout(EXPORT_CLEANUP_TIMEOUT_MS),
      ),
    );
    signal.throwIfAborted();
    return;
  }
  signal.throwIfAborted();

  await get(
    enqueueExportReadyEmail(
      runtime,
      {
        userId: args.userId,
        downloadUrl,
        expiresAt,
        artifactCount: 0,
      },
      signal,
    ),
  );
  signal.throwIfAborted();

  log.debug("export job completed", { jobId: args.jobId });
});

export const executeUserExportJob$ = command(
  async (
    { set },
    args: ExecuteUserExportJobArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const runtime: ExportRuntime = {
      db,
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    };

    await onRejection(
      set(runExportJob$, runtime, args, signal),
      async (error) => {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        log.error("export job failed", { jobId: args.jobId, error });

        await db
          .update(exportJobs)
          .set({
            status: "failed",
            error: errorMessage,
            completedAt: nowDate(),
          })
          .where(
            and(
              eq(exportJobs.id, args.jobId),
              inArray(exportJobs.status, ["pending", "running"]),
            ),
          );
      },
    );
    signal.throwIfAborted();
  },
);
