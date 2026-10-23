import { v5 as uuidv5 } from "uuid";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  socialKitDownloadDeliveredQualitySchema,
  socialKitDownloadFormatSchema,
  socialKitDownloadPlatformSchema,
  socialKitDownloadResponseSchema,
  type SocialKitDownloadListQuery,
  type SocialKitDownloadListResponse,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitErrorResponse,
} from "@okouai/api-contracts/contracts/social";
import { socialKitDownloadJobs } from "@okouai/db/schema/socialkit-download-job";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as z from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { type Db, writeDb$ } from "../external/db";
import {
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  settle,
  settleIncludingAbort,
} from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import { creditPolicyRunId } from "./official-workflow-policy.service";
import { validateScrapeTargetUrl } from "./scrape-target-policy";
import { normalizeSocialKitError } from "./socialkit-error";

const SOCIALKIT_API_BASE = "https://api.socialkit.dev";
const SOCIALKIT_PROVIDER_TIMEOUT_MS = 240_000;
export const SOCIALKIT_RECONCILIATION_TIMEOUT_MS = 280_000;
const CLAIM_CLEANUP_TIMEOUT_MS = 10_000;
// SocialKit charges when ready is observed, so durable settlement gets an independent budget.
const READY_SETTLEMENT_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROVIDER_FAILURE_CODE_CHARS = 128;
const MAX_PROVIDER_FAILURE_MESSAGE_CHARS = 500;
const PROVIDER_FAILURE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PROVIDER_FAILURE_URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu;
const PROVIDER_FAILURE_CREDENTIAL_PATTERN =
  /\b(?:access[ _-]?key|api[ _-]?key|authorization|password|token)\s*[:=]\s*\S+/iu;
const PROVIDER_FAILURE_STACK_PATTERN =
  /(?:\bat\s+(?:async\s+)?(?:\S+\s+\()?[^()\s]+:\d+:\d+\)?|\bFile\s+"[^"]+",\s+line\s+\d+)/u;
const RECONCILE_BATCH_SIZE = 2;
const USAGE_NAMESPACE = "42a65d9f-67d6-4bed-ae87-9f80ce1feb79";
const ACTIVE_STATUSES = ["processing", "link_failed"] as const;

type DownloadJob = typeof socialKitDownloadJobs.$inferSelect;
type DownloadJobError = NonNullable<DownloadJob["error"]>;
type DownloadLink = NonNullable<SocialKitDownloadResponse["download"]>;

const PROVIDER_DOWNLOAD_FAILED_ERROR = {
  code: "SOCIALKIT_DOWNLOAD_FAILED",
  message: "SocialKit could not prepare the download",
} satisfies DownloadJobError;

const INVALID_METADATA_ERROR = {
  code: "SOCIALKIT_INVALID_DOWNLOAD_RESPONSE",
  message: "SocialKit returned invalid download metadata",
} satisfies DownloadJobError;

interface SocialKitDownloadErrorResponse {
  readonly status: 400 | 404 | 409 | 422 | 429 | 502 | 503;
  readonly body: SocialKitErrorResponse;
}

class ProviderRequestError extends Error {
  readonly details: DownloadJobError;

  constructor(readonly normalized: ReturnType<typeof normalizeSocialKitError>) {
    super(normalized.error.message);
    this.name = "ProviderRequestError";
    this.details = { ...normalized.error, provider: normalized.evidence };
  }
}

type CreateSocialKitDownloadResponse =
  | { readonly status: 202; readonly body: SocialKitDownloadResponse }
  | ManagedUsageErrorResponse
  | SocialKitDownloadErrorResponse;

interface CreateSocialKitDownloadArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialKitDownloadRequest;
}

const providerStartSchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.enum(["queued", "processing"]),
});

const providerFileSizeMbSchema = z.union([
  z.number().nonnegative(),
  z
    .string()
    .max(32)
    .regex(/^\d+(?:\.\d+)? MB$/u)
    .transform((value) => {
      return Number.parseFloat(value);
    })
    .pipe(z.number().finite().nonnegative()),
]);

const providerReadySchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.literal("ready"),
  platform: socialKitDownloadPlatformSchema,
  downloadUrl: z.url().max(8192),
  expiresIn: z.number().int().positive().max(604_800).optional(),
  durationSeconds: z.number().int().positive(),
  fileSizeMB: providerFileSizeMbSchema,
  creditsCost: z.number().int().positive(),
  billed: z.literal(true).optional(),
  quality: socialKitDownloadDeliveredQualitySchema,
  format: socialKitDownloadFormatSchema,
  title: z.unknown().optional(),
  thumbnail: z.unknown().optional(),
});

const providerFailedSchema = z.object({
  status: z.literal("failed"),
  errorCode: z
    .string()
    .min(1)
    .max(MAX_PROVIDER_FAILURE_CODE_CHARS)
    .regex(PROVIDER_FAILURE_CODE_PATTERN),
  error: z.string().trim().min(1).max(MAX_PROVIDER_FAILURE_MESSAGE_CHARS),
  retryable: z.unknown().optional(),
});

const providerThumbnailSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  });

type ProviderReady = z.infer<typeof providerReadySchema>;

function errorResponse(
  status: 409 | 502 | 503,
  message: string,
  code: string,
): SocialKitDownloadErrorResponse {
  return { status, body: { error: { message, code } } };
}

function runId(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function responseForJob(job: DownloadJob): SocialKitDownloadResponse {
  const billed = job.creditsCharged !== null;
  return socialKitDownloadResponseSchema.parse({
    downloadId: job.id,
    status: job.status === "submitting" ? "queued" : job.status,
    platform: job.request.platform,
    requested: { quality: job.request.quality, format: job.request.format },
    delivered: {
      quality:
        job.providerResult?.format === "mp4"
          ? job.providerResult.quality
          : null,
      format: job.providerResult ? job.providerResult.format : null,
    },
    maxDuration: job.request.maxDuration,
    billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
    provider: job.providerResult,
    billing:
      job.providerResult && billed
        ? {
            quantity: job.providerResult.creditsCost,
            creditsCharged: job.creditsCharged,
          }
        : null,
    download: null,
    error: job.error
      ? {
          code: job.error.code,
          message: job.error.message,
          ...(job.error.reason === undefined
            ? {}
            : { reason: job.error.reason }),
          ...(job.error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: job.error.retryAfterSeconds }),
          ...(job.error.resubmitRetryable === undefined
            ? {}
            : { resubmitRetryable: job.error.resubmitRetryable }),
          retryable:
            (job.status === "processing" || job.status === "link_failed") &&
            (job.error.retryable ?? true),
          billed,
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

function providerBody(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    value.success === true &&
    "data" in value
  ) {
    return value.data;
  }
  return value;
}

function safeProviderFailureMessage(
  message: string,
  accessKey: string,
): string | null {
  const hasControlCharacter = [...message].some((character) => {
    const codeUnit = character.charCodeAt(0);
    return (
      codeUnit <= 31 ||
      (codeUnit >= 127 && codeUnit <= 159) ||
      codeUnit === 0x20_28 ||
      codeUnit === 0x20_29
    );
  });
  if (
    hasControlCharacter ||
    PROVIDER_FAILURE_URL_PATTERN.test(message) ||
    PROVIDER_FAILURE_CREDENTIAL_PATTERN.test(message) ||
    PROVIDER_FAILURE_STACK_PATTERN.test(message) ||
    message.includes(accessKey)
  ) {
    return null;
  }
  return message;
}

function providerFailureError(
  value: unknown,
  accessKey: string,
): DownloadJobError | null {
  const parsed = providerFailedSchema.safeParse(value);
  const normalized = normalizeSocialKitError(200, value, { accessKey });
  if (
    !parsed.success &&
    normalized.evidence.errorCode === undefined &&
    normalized.evidence.retryable === undefined
  ) {
    return null;
  }
  return {
    code:
      parsed.success && normalized.evidence.errorCode
        ? `SOCIALKIT_PROVIDER_${normalized.evidence.errorCode}`
        : PROVIDER_DOWNLOAD_FAILED_ERROR.code,
    message:
      (parsed.success
        ? safeProviderFailureMessage(parsed.data.error, accessKey)
        : null) ?? PROVIDER_DOWNLOAD_FAILED_ERROR.message,
    reason: normalized.error.reason,
    resubmitRetryable: normalized.error.retryable,
    provider: normalized.evidence,
  };
}

async function providerJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ]),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (text.kind === "too_large") {
    throw new Error("SocialKit returned an oversized job response");
  }
  return {
    response,
    body: providerBody(text.text ? safeJsonParse(text.text) : undefined),
  };
}

async function startProviderJob(
  accessKey: string,
  request: SocialKitDownloadRequest,
  signal: AbortSignal,
): Promise<string> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/${request.platform}/download`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": accessKey,
      },
      body: JSON.stringify({
        url: request.url,
        max_duration: request.maxDuration,
        quality: request.quality,
        format: request.format,
      }),
    },
    signal,
  );
  if (!result.response.ok) {
    throw new ProviderRequestError(
      normalizeSocialKitError(result.response.status, result.body, {
        accessKey,
        headers: result.response.headers,
      }),
    );
  }
  return providerStartSchema.parse(result.body).jobId;
}

type ProviderPollResult =
  | { readonly status: "processing" }
  | { readonly status: "failed"; readonly error: DownloadJobError | null }
  | { readonly status: "invalid" }
  | { readonly status: "ready"; readonly ready: ProviderReady };

async function pollProviderJob(
  accessKey: string,
  providerJobId: string,
  signal: AbortSignal,
): Promise<ProviderPollResult> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/downloads/${encodeURIComponent(providerJobId)}`,
    { method: "GET", headers: { "x-access-key": accessKey } },
    signal,
  );
  if (!result.response.ok) {
    if (result.response.status === 404) {
      return { status: "failed", error: null };
    }
    throw new ProviderRequestError(
      normalizeSocialKitError(result.response.status, result.body, {
        accessKey,
        headers: result.response.headers,
      }),
    );
  }
  if (
    typeof result.body !== "object" ||
    result.body === null ||
    !("status" in result.body) ||
    typeof result.body.status !== "string"
  ) {
    return { status: "invalid" };
  }
  if (result.body.status === "failed") {
    return {
      status: "failed",
      error: providerFailureError(result.body, accessKey),
    };
  }
  if (result.body.status === "queued" || result.body.status === "processing") {
    return { status: "processing" };
  }
  if (result.body.status !== "ready") {
    return { status: "invalid" };
  }
  const ready = providerReadySchema.safeParse(result.body);
  return ready.success
    ? { status: "ready", ready: ready.data }
    : { status: "invalid" };
}

function usageIdempotencyKey(downloadId: string): string {
  return uuidv5(
    `${downloadId}:${MANAGED_SOCIALKIT_BILLING_CATEGORY}`,
    USAGE_NAMESPACE,
  );
}

function providerCreditsPerMinute(media: {
  readonly quality: string;
  readonly format: SocialKitDownloadRequest["format"];
}): number {
  return media.format === "mp4" && Number.parseInt(media.quality, 10) >= 720
    ? 4
    : 1;
}

function readyMetadataIsValid(job: DownloadJob, ready: ProviderReady): boolean {
  const minutes = Math.ceil(ready.durationSeconds / 60);
  const requestedRate = providerCreditsPerMinute(job.request);
  const deliveredRate =
    job.request.platform === "tiktok"
      ? Math.min(requestedRate, providerCreditsPerMinute(ready))
      : requestedRate;
  return !(
    ready.jobId !== job.providerJobId ||
    ready.platform !== job.request.platform ||
    ready.format !== job.request.format ||
    ready.durationSeconds > job.request.maxDuration ||
    ready.creditsCost !== minutes * deliveredRate ||
    ready.creditsCost >
      Math.ceil(job.request.maxDuration / 60) * requestedRate ||
    (job.providerResult !== null &&
      (ready.creditsCost !== job.providerResult.creditsCost ||
        ready.durationSeconds !== job.providerResult.durationSeconds))
  );
}

async function deferClaimedJob(
  writeDb: Db,
  job: DownloadJob,
  error: DownloadJobError | undefined,
  signal: AbortSignal,
): Promise<void> {
  const [current] = await writeDb
    .select({ creditsCharged: socialKitDownloadJobs.creditsCharged })
    .from(socialKitDownloadJobs)
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
  const billed = current !== undefined && current.creditsCharged !== null;
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: billed ? "link_failed" : "processing",
      error: error ?? {
        code: billed
          ? "SOCIALKIT_DOWNLOAD_LINK_UNAVAILABLE"
          : "SOCIALKIT_RECONCILIATION_FAILED",
        message: billed
          ? "The temporary download link is unavailable"
          : "The SocialKit download could not be reconciled yet",
      },
      retryCount: sql`${socialKitDownloadJobs.retryCount} + 1`,
      claimExpiresAt: sql`now() + GREATEST(LEAST(30, ${socialKitDownloadJobs.retryCount} + 1) * 60, ${error?.retryAfterSeconds ?? 0}) * interval '1 second'`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
}

async function startAndPersistProviderJob(
  writeDb: Db,
  created: DownloadJob,
  accessKey: string,
  request: SocialKitDownloadRequest,
): Promise<
  | { readonly job: DownloadJob }
  | { readonly failure: SocialKitDownloadErrorResponse }
> {
  const started = await settleIncludingAbort(
    startProviderJob(
      accessKey,
      request,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ),
  );
  if (!started.ok) {
    const normalized =
      started.error instanceof ProviderRequestError
        ? started.error.normalized
        : undefined;
    const failure: SocialKitDownloadErrorResponse = normalized
      ? { status: normalized.status, body: { error: normalized.error } }
      : {
          status: 502,
          body: {
            error: {
              code: "SOCIALKIT_DOWNLOAD_START_FAILED",
              message: "SocialKit could not start the download",
              retryable: false,
            },
          },
        };
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "provider_failed",
        error: {
          ...failure.body.error,
          ...(normalized
            ? {
                provider: normalized.evidence,
                resubmitRetryable: normalized.error.retryable,
              }
            : {}),
        },
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, created.id));
    return { failure };
  }
  const [processing] = await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      providerJobId: started.value,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, created.id),
        eq(socialKitDownloadJobs.status, "submitting"),
      ),
    )
    .returning();
  if (!processing) {
    throw new Error("Failed to persist SocialKit provider job");
  }
  return { job: processing };
}

export const createSocialKitDownload$ = command(
  async (
    { set },
    args: CreateSocialKitDownloadArgs,
    signal: AbortSignal,
  ): Promise<CreateSocialKitDownloadResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }
    const creditError = await set(
      checkManagedCredits$,
      {
        runId: creditPolicyRunId(args.auth),
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity:
            Math.ceil(args.body.maxDuration / 60) *
            providerCreditsPerMinute(args.body),
        },
        label: "Okou SocialKit download",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const [created] = await writeDb
      .insert(socialKitDownloadJobs)
      .values({
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runId(args.auth),
        request: args.body,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();
    if (!created) {
      return errorResponse(
        409,
        "Another social media download is already in progress",
        "DOWNLOAD_IN_PROGRESS",
      );
    }
    const processing = await startAndPersistProviderJob(
      writeDb,
      created,
      accessKey,
      args.body,
    );
    signal.throwIfAborted();
    if ("failure" in processing) {
      return processing.failure;
    }
    return { status: 202, body: responseForJob(processing.job) };
  },
);

export const getSocialKitDownload$ = command(
  async (
    { set },
    args: {
      readonly downloadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<SocialKitDownloadResponse | null> => {
    const writeDb = set(writeDb$);
    const ownership = and(
      eq(socialKitDownloadJobs.id, args.downloadId),
      eq(socialKitDownloadJobs.orgId, args.orgId),
      eq(socialKitDownloadJobs.userId, args.userId),
    );
    const [job] = await writeDb
      .select()
      .from(socialKitDownloadJobs)
      .where(ownership);
    signal.throwIfAborted();
    if (!job) {
      return null;
    }
    if (job.status === "provider_failed" || job.status === "submitting") {
      return responseForJob(job);
    }
    if (job.status === "completed") {
      return set(refreshSocialKitDownloadLink$, job, signal);
    }
    // Reconcile in the foreground and reuse this poll's link instead of polling twice.
    const reconciled = await set(reconcileSocialKitDownload$, job.id, signal);
    const [updated] = await writeDb
      .select()
      .from(socialKitDownloadJobs)
      .where(ownership);
    signal.throwIfAborted();
    if (!updated) {
      return null;
    }
    if (typeof reconciled === "object" && updated.status === "completed") {
      return { ...responseForJob(updated), download: reconciled.download };
    }
    return updated.status === "completed"
      ? set(refreshSocialKitDownloadLink$, updated, signal)
      : responseForJob(updated);
  },
);

export const listSocialKitDownloads$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly query: SocialKitDownloadListQuery;
    },
    signal: AbortSignal,
  ): Promise<SocialKitDownloadListResponse> => {
    const db = set(writeDb$);
    const { limit, cursor, status } = args.query;
    const anchor = alias(socialKitDownloadJobs, "download_cursor");
    const rows = await db
      .select()
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.orgId, args.orgId),
          eq(socialKitDownloadJobs.userId, args.userId),
          status === "active"
            ? inArray(socialKitDownloadJobs.status, [
                "submitting",
                ...ACTIVE_STATUSES,
              ])
            : status === undefined
              ? undefined
              : eq(
                  socialKitDownloadJobs.status,
                  status === "queued" ? "submitting" : status,
                ),
          cursor === undefined
            ? undefined
            : lt(
                sql`(${socialKitDownloadJobs.createdAt}, ${socialKitDownloadJobs.id})`,
                db
                  .select({ createdAt: anchor.createdAt, id: anchor.id })
                  .from(anchor)
                  .where(
                    and(
                      eq(anchor.id, cursor),
                      eq(anchor.orgId, args.orgId),
                      eq(anchor.userId, args.userId),
                    ),
                  ),
              ),
        ),
      )
      .orderBy(
        desc(socialKitDownloadJobs.createdAt),
        desc(socialKitDownloadJobs.id),
      )
      .limit(limit + 1);
    signal.throwIfAborted();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      downloads: page.map((job) => {
        return {
          ...responseForJob(job),
          request: {
            platform: job.request.platform,
            url: job.request.url,
            maxDuration: job.request.maxDuration,
            quality: job.request.quality,
            format: job.request.format,
          },
          resumeCommand:
            job.status === "provider_failed"
              ? null
              : `okou data social download --resume ${job.id}`,
        };
      }),
      nextCursor: rows.length > limit && last ? last.id : null,
    };
  },
);

const claimSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<DownloadJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        claimExpiresAt: sql`now() + interval '15 minutes'`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, downloadId),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return job ?? null;
  },
);

function safeProviderResult(ready: ProviderReady) {
  const thumbnail = providerThumbnailSchema.safeParse(ready.thumbnail);
  const downloadUrl = new URL(ready.downloadUrl);
  downloadUrl.hash = "";
  const thumbnailUrl = thumbnail.success ? new URL(thumbnail.data) : null;
  if (thumbnailUrl) {
    thumbnailUrl.hash = "";
  }
  const safeThumbnail =
    thumbnail.success && thumbnailUrl?.href !== downloadUrl.href
      ? thumbnail.data
      : undefined;
  return {
    durationSeconds: ready.durationSeconds,
    fileSizeMB: ready.fileSizeMB,
    creditsCost: ready.creditsCost,
    quality: ready.quality,
    format: ready.format,
    ...(typeof ready.title === "string" && ready.title.length <= 1000
      ? { title: ready.title }
      : {}),
    ...(safeThumbnail ? { thumbnail: safeThumbnail } : {}),
  };
}

const settleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly quantity: number },
    signal: AbortSignal,
  ): Promise<number> => {
    if (args.job.creditsCharged !== null) {
      return args.job.creditsCharged;
    }
    return await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.job.orgId,
          userId: args.job.userId,
          ...(args.job.runId ? { runId: args.job.runId } : {}),
        },
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity: args.quantity,
        },
        label: "SocialKit download",
        idempotencyKey: usageIdempotencyKey(args.job.id),
      },
      signal,
    );
  },
);

const persistAndSettleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: {
      readonly job: DownloadJob;
      readonly providerResult: NonNullable<DownloadJob["providerResult"]>;
    },
    signal: AbortSignal,
  ): Promise<DownloadJob> => {
    const writeDb = set(writeDb$);
    const [readyJob] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        providerResult: args.providerResult,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!readyJob) {
      throw new Error("Failed to persist SocialKit ready metadata");
    }
    const creditsCharged = await set(
      settleSocialKitDownloadUsage$,
      { job: readyJob, quantity: args.providerResult.creditsCost },
      signal,
    );
    const [processing] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "processing",
        creditsCharged,
        error: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!processing) {
      throw new Error("Failed to persist SocialKit usage settlement");
    }
    return processing;
  },
);

function directDownloadLink(
  ready: ProviderReady,
  accessKey: string,
): DownloadLink {
  const target = validateScrapeTargetUrl(ready.downloadUrl);
  if (typeof target === "string" || target.url.protocol !== "https:") {
    throw new Error("SocialKit returned an unsafe download link");
  }
  const { url } = target;
  // Only file-scoped URLs from the documented bucket may cross the caller boundary.
  if (
    url.hostname !== "socialkit-downloads.s3.amazonaws.com" ||
    url.port !== "" ||
    url.hash !== "" ||
    url.pathname === "/" ||
    ready.downloadUrl.includes(accessKey) ||
    ready.downloadUrl.includes(encodeURIComponent(accessKey)) ||
    decodeURIComponent(url.pathname).includes(accessKey) ||
    [...url.searchParams].some(([key, value]) => {
      return (
        /^(?:access[_-]?key|x-access-key|authorization)$/iu.test(key) ||
        key.includes(accessKey) ||
        value.includes(accessKey)
      );
    })
  ) {
    throw new Error("SocialKit returned an unsafe download link");
  }
  return {
    // Preserve signed bytes; never reconstruct or persist this bearer URL.
    url: ready.downloadUrl,
    expiresAt:
      ready.expiresIn === undefined
        ? null
        : new Date(nowDate().getTime() + ready.expiresIn * 1000).toISOString(),
  };
}

const refreshSocialKitDownloadLink$ = command(
  async (
    _,
    job: DownloadJob,
    signal: AbortSignal,
  ): Promise<SocialKitDownloadResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    const refreshed = await settle(
      (async () => {
        if (!accessKey || !job.providerJobId) {
          throw new Error("Social download link is unavailable");
        }
        const poll = await pollProviderJob(
          accessKey,
          job.providerJobId,
          signal,
        );
        if (poll.status !== "ready" || !readyMetadataIsValid(job, poll.ready)) {
          throw new Error("Social download link is unavailable");
        }
        return directDownloadLink(poll.ready, accessKey);
      })(),
    );
    signal.throwIfAborted();
    if (!refreshed.ok) {
      return {
        ...responseForJob(job),
        download: null,
        error: {
          code: "SOCIALKIT_DOWNLOAD_LINK_UNAVAILABLE",
          message:
            "The temporary download link could not be refreshed; query this download again",
          retryable: true,
          billed: job.creditsCharged !== null,
        },
      };
    }
    return { ...responseForJob(job), download: refreshed.value };
  },
);

const completeReadySocialKitDownload$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly ready: ProviderReady },
    signal: AbortSignal,
  ): Promise<DownloadLink> => {
    const providerResult =
      args.job.providerResult ?? safeProviderResult(args.ready);
    const settledJob = await set(
      persistAndSettleSocialKitDownloadUsage$,
      { job: args.job, providerResult },
      AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      throw new Error("SocialKit provider is not configured");
    }
    const download = directDownloadLink(args.ready, accessKey);
    const writeDb = set(writeDb$);
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "completed",
        providerResult,
        creditsCharged: settledJob.creditsCharged,
        error: null,
        claimExpiresAt: null,
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, args.job.id));
    signal.throwIfAborted();
    return download;
  },
);

async function recordProcessingPoll(
  writeDb: Db,
  job: DownloadJob,
): Promise<void> {
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      error: null,
      retryCount: 0,
      claimExpiresAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

async function recordProviderFailure(
  writeDb: Db,
  job: DownloadJob,
  signal: AbortSignal,
  error: DownloadJobError,
): Promise<void> {
  if (job.creditsCharged !== null) {
    await deferClaimedJob(writeDb, job, undefined, signal);
    return;
  }
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "provider_failed",
      error,
      claimExpiresAt: null,
      updatedAt: nowDate(),
      completedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

export const reconcileSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<boolean | { readonly download: DownloadLink }> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return false;
    }
    let job = await set(claimSocialKitDownload$, downloadId, signal);
    if (!job) {
      return false;
    }
    const writeDb = set(writeDb$);
    const providerJobId = job.providerJobId;
    if (!providerJobId) {
      await recordProviderFailure(writeDb, job, signal, INVALID_METADATA_ERROR);
      signal.throwIfAborted();
      return true;
    }
    if (job.providerResult && job.creditsCharged === null) {
      const recovered = await settle(
        set(
          persistAndSettleSocialKitDownloadUsage$,
          { job, providerResult: job.providerResult },
          AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
        ),
      );
      if (signal.aborted) {
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            undefined,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      }
      signal.throwIfAborted();
      if (!recovered.ok) {
        await deferClaimedJob(writeDb, job, undefined, signal);
        signal.throwIfAborted();
        return true;
      }
      job = recovered.value;
    }
    return await onRejection(
      (async (): Promise<boolean | { readonly download: DownloadLink }> => {
        const poll = await settle(
          pollProviderJob(accessKey, providerJobId, signal),
        );
        signal.throwIfAborted();
        if (!poll.ok) {
          await deferClaimedJob(
            writeDb,
            job,
            poll.error instanceof ProviderRequestError
              ? poll.error.details
              : undefined,
            signal,
          );
          return true;
        }
        if (poll.value.status === "processing") {
          if (job.creditsCharged === null) {
            await recordProcessingPoll(writeDb, job);
          } else {
            await deferClaimedJob(writeDb, job, undefined, signal);
          }
          signal.throwIfAborted();
          return true;
        }
        if (poll.value.status === "failed") {
          await recordProviderFailure(
            writeDb,
            job,
            signal,
            poll.value.error ?? PROVIDER_DOWNLOAD_FAILED_ERROR,
          );
          signal.throwIfAborted();
          return true;
        }
        if (
          poll.value.status === "invalid" ||
          !readyMetadataIsValid(job, poll.value.ready)
        ) {
          await recordProviderFailure(
            writeDb,
            job,
            signal,
            INVALID_METADATA_ERROR,
          );
          signal.throwIfAborted();
          return true;
        }
        const completed = await settle(
          set(
            completeReadySocialKitDownload$,
            { job, ready: poll.value.ready },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (!completed.ok) {
          await deferClaimedJob(writeDb, job, undefined, signal);
          return true;
        }
        return { download: completed.value };
      })(),
      async () => {
        if (!signal.aborted) {
          return;
        }
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            undefined,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      },
    );
  },
);

export const reconcileSocialKitDownloads$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const writeDb = set(writeDb$);
    const staleCandidates = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.status, "submitting"),
          lt(
            socialKitDownloadJobs.createdAt,
            sql`now() - interval '15 minutes'`,
          ),
        ),
      )
      .orderBy(socialKitDownloadJobs.createdAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();
    const staleSubmissions =
      staleCandidates.length === 0
        ? []
        : await writeDb
            .update(socialKitDownloadJobs)
            .set({
              status: "provider_failed",
              error: {
                code: "SOCIALKIT_DOWNLOAD_START_INTERRUPTED",
                message: "The SocialKit download start was interrupted",
              },
              updatedAt: nowDate(),
              completedAt: nowDate(),
            })
            .where(
              and(
                inArray(
                  socialKitDownloadJobs.id,
                  staleCandidates.map((candidate) => {
                    return candidate.id;
                  }),
                ),
                eq(socialKitDownloadJobs.status, "submitting"),
              ),
            )
            .returning({ id: socialKitDownloadJobs.id });
    signal.throwIfAborted();
    const activeLimit = RECONCILE_BATCH_SIZE - staleSubmissions.length;
    if (activeLimit === 0) {
      return staleSubmissions.length;
    }
    const jobs = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
        ),
      )
      .orderBy(socialKitDownloadJobs.updatedAt)
      .limit(activeLimit);
    signal.throwIfAborted();
    let processed = staleSubmissions.length;
    for (const job of jobs) {
      if (await set(reconcileSocialKitDownload$, job.id, signal)) {
        processed += 1;
      }
    }
    return processed;
  },
);
