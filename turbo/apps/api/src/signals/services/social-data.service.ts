import { isDeepStrictEqual } from "node:util";

import {
  socialDataCreateRequestSchema,
  socialDataJobResponseSchema,
  type SocialDataCreateRequest,
  type SocialDataJobResponse,
  type SocialDataListQuery,
  type SocialDataListResponse,
  type SocialDataQuoteResponse,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { writeDb$, type Db } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import { completeProcessedOrgUsage$ } from "./credit-usage.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  checkManagedCreditsInDb,
  recordManagedUsageInTransaction,
} from "./managed-usage.service";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";
import {
  inspectSocialDataProviderPlan,
  readSocialDataProviderRun,
  startSocialDataProviderRun,
  stopSocialDataProviderRun,
  type SocialDataProviderQuote,
  type SocialDataProviderRun,
} from "./social-data-provider";
import {
  prepareSocialDataProviderPlan,
  SocialDataProviderError,
  type SocialDataProviderPlan,
} from "./social-data-provider-catalog";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

export const SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS = 240_000;
const CLAIM_MS = 180_000;
const BILLING_CATEGORY = "provider_cost_usd_micros";
type Actor = AuthContext & { readonly orgId: string };
type Job = typeof socialDataJobs.$inferSelect;
type ErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503;
interface ErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: { readonly code: string; readonly message: string };
  };
}
type CreatedResponse = {
  readonly status: 202;
  readonly body: SocialDataJobResponse;
};
interface Claim {
  readonly job: Job;
  readonly expiresAt: Date;
}

function errorResponse(
  status: ErrorStatus,
  code: string,
  message: string,
): ErrorResponse {
  return { status, body: { error: { code, message } } };
}

function providerErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof SocialDataProviderError) {
    return errorResponse(error.status, error.code, error.message);
  }
  throw error;
}

function requestOf(body: SocialDataCreateRequest): SocialDataRequest {
  const { requestId: _requestId, maxCredits: _maxCredits, ...request } = body;
  return request;
}

function providerFor(platform: SocialDataRequest["platform"]): string {
  return `monid/${platform}`;
}

async function admitSocialOwner(
  tx: Tx,
  owner: Pick<Actor, "userId" | "orgId">,
): Promise<boolean> {
  // Legacy Clerk cleanup records its durable closure in this shared subject fence.
  return await admitPiStableContextSubjects(tx, [
    { subjectKind: "user", subjectId: owner.userId },
    { subjectKind: "organization", subjectId: owner.orgId },
  ]);
}

function creditsFor(cost: number, unitPrice: number, unitSize: number): number {
  if (
    ![cost, unitPrice, unitSize].every(Number.isSafeInteger) ||
    cost < 0 ||
    unitPrice < 0 ||
    unitSize <= 0
  ) {
    throw new SocialDataProviderError(
      "PRICING_NOT_CONFIGURED",
      "Social data pricing is unavailable.",
      503,
    );
  }
  const denominator = BigInt(unitSize);
  const result =
    (BigInt(cost) * BigInt(unitPrice) + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_LIMIT_EXCEEDED",
      "The requested operation exceeds the supported budget.",
      422,
    );
  }
  return Number(result);
}

function publicJob(job: Job): SocialDataJobResponse {
  return socialDataJobResponseSchema.parse({
    jobId: job.id,
    requestId: job.requestId,
    platform: job.platform,
    operation: job.operation,
    status: job.status,
    data: job.result,
    billing: {
      state: job.creditsCharged === null ? "pending" : "settled",
      creditsCharged: job.creditsCharged ?? 0,
      reservedCredits: job.reservedCredits,
      maxCredits: job.maxCredits,
    },
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  });
}

async function requireEnabled(
  db: Db,
  auth: Actor,
  signal: AbortSignal,
): Promise<ErrorResponse | null> {
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.SocialDataJobs, context)
    ? null
    : errorResponse(
        403,
        "FEATURE_NOT_AVAILABLE",
        "Social data jobs are not enabled for this account.",
      );
}

function ownerWhere(auth: Pick<Actor, "orgId" | "userId">, jobId: string) {
  return and(
    eq(socialDataJobs.id, jobId),
    eq(socialDataJobs.orgId, auth.orgId),
    eq(socialDataJobs.userId, auth.userId),
  );
}

async function findOwnedJob(
  db: Db,
  auth: Pick<Actor, "orgId" | "userId">,
  jobId: string,
): Promise<Job | undefined> {
  const [job] = await db
    .select()
    .from(socialDataJobs)
    .where(ownerWhere(auth, jobId));
  return job;
}

function requestWhere(auth: Actor, body: SocialDataCreateRequest) {
  return and(
    eq(socialDataJobs.orgId, auth.orgId),
    eq(socialDataJobs.userId, auth.userId),
    eq(socialDataJobs.requestId, body.requestId),
  );
}

function replayJob(
  job: Job,
  body: SocialDataCreateRequest,
): CreatedResponse | ErrorResponse {
  return isDeepStrictEqual(job.request, body)
    ? { status: 202, body: publicJob(job) }
    : errorResponse(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This request ID belongs to different Social inputs.",
      );
}

async function loadPricing(
  db: Db,
  platform: SocialDataRequest["platform"],
  resolution: UsagePricingResolution,
) {
  const provider = resolveUsagePricingProvider(
    resolution,
    "social",
    providerFor(platform),
  );
  const [pricing] = await db
    .select()
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "social"),
        eq(usagePricing.provider, provider),
        eq(usagePricing.category, BILLING_CATEGORY),
      ),
    )
    .for("share");
  if (!pricing) {
    throw new SocialDataProviderError(
      "PRICING_NOT_CONFIGURED",
      "Social data pricing is unavailable.",
      503,
    );
  }
  return pricing;
}

export const quoteSocialData$ = command(
  async (
    { get, set },
    args: { readonly auth: Actor; readonly body: SocialDataRequest },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: SocialDataQuoteResponse }
    | ErrorResponse
  > => {
    const db = set(writeDb$);
    const disabled = await requireEnabled(db, args.auth, signal);
    if (disabled) {
      return disabled;
    }
    const result = await settle(
      (async () => {
        const estimate = await inspectSocialDataProviderPlan(
          prepareSocialDataProviderPlan(args.body),
          signal,
        );
        signal.throwIfAborted();
        const pricing = await loadPricing(
          db,
          args.body.platform,
          get(usagePricingResolution$),
        );
        signal.throwIfAborted();
        const credits = creditsFor(
          estimate.estimatedCostUsdMicros,
          pricing.unitPrice,
          pricing.unitSize,
        );
        return {
          status: 200 as const,
          body: {
            platform: args.body.platform,
            operation: args.body.operation,
            estimatedCredits: credits,
            maxCredits: credits,
            quantity: estimate.quantity,
            unit: estimate.unit,
          },
        };
      })(),
      signal,
    );
    return result.ok ? result.value : providerErrorResponse(result.error);
  },
);

async function checkBudget(
  tx: Tx,
  args: {
    readonly auth: Actor;
    readonly request: SocialDataRequest;
    readonly estimate: SocialDataProviderQuote;
    readonly estimatedCredits: number;
    readonly maxCredits: number;
    readonly resolution: UsagePricingResolution;
  },
  signal: AbortSignal,
): Promise<ErrorResponse | null> {
  if (args.maxCredits < args.estimatedCredits) {
    return errorResponse(
      402,
      "BUDGET_EXCEEDED",
      "The estimated Social data cost exceeds --max-credits. Reduce the result limit or raise the budget.",
    );
  }
  const [reservation] = await tx
    .select({
      credits:
        sql`COALESCE(sum(${socialDataJobs.reservedCredits}), 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
      jobs: sql`count(*)::bigint`.mapWith(pgInt8ToSafeIntegerDecoder),
    })
    .from(socialDataJobs)
    .where(
      and(
        eq(socialDataJobs.orgId, args.auth.orgId),
        isNull(socialDataJobs.creditsCharged),
      ),
    );
  signal.throwIfAborted();
  if ((reservation?.jobs ?? 0) >= 100) {
    return errorResponse(
      429,
      "SOCIAL_DATA_CAPACITY",
      "Wait for existing Social data jobs to finish.",
    );
  }
  if (args.maxCredits === 0) {
    return null;
  }
  return await checkManagedCreditsInDb(
    tx,
    {
      orgId: args.auth.orgId,
      userId: args.auth.userId,
      resource: {
        kind: "social",
        provider: providerFor(args.request.platform),
        category: BILLING_CATEGORY,
        quantity: Math.max(1, args.estimate.estimatedCostUsdMicros),
      },
      label: "Okou Social",
      reservedCredits:
        (reservation?.credits ?? 0) + args.maxCredits - args.estimatedCredits,
      enforceBalance: true,
    },
    args.resolution,
    signal,
  );
}

async function admitJob(
  tx: Tx,
  args: {
    readonly auth: Actor;
    readonly body: SocialDataCreateRequest;
    readonly plan: SocialDataProviderPlan;
    readonly estimate: SocialDataProviderQuote;
    readonly resolution: UsagePricingResolution;
  },
  signal: AbortSignal,
): Promise<CreatedResponse | ErrorResponse> {
  if (!(await admitSocialOwner(tx, args.auth))) {
    return errorResponse(
      403,
      "SOCIAL_DATA_OWNER_UNAVAILABLE",
      "This account cannot start Social data jobs.",
    );
  }
  signal.throwIfAborted();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`social-data:${args.auth.orgId}`}, 0))`,
  );
  signal.throwIfAborted();
  const [duplicate] = await tx
    .select()
    .from(socialDataJobs)
    .where(requestWhere(args.auth, args.body));
  signal.throwIfAborted();
  if (duplicate) {
    return replayJob(duplicate, args.body);
  }
  const request = requestOf(args.body);
  const pricing = await loadPricing(tx, request.platform, args.resolution);
  signal.throwIfAborted();
  const estimatedCredits = creditsFor(
    args.estimate.estimatedCostUsdMicros,
    pricing.unitPrice,
    pricing.unitSize,
  );
  const maxCredits = args.body.maxCredits ?? estimatedCredits;
  const rejected = await checkBudget(
    tx,
    { ...args, request, estimatedCredits, maxCredits },
    signal,
  );
  if (rejected) {
    return rejected;
  }
  const [job] = await tx
    .insert(socialDataJobs)
    .values({
      orgId: args.auth.orgId,
      userId: args.auth.userId,
      requestId: args.body.requestId,
      billingRunId:
        args.auth.tokenType === "agent" || args.auth.tokenType === "sandbox"
          ? args.auth.runId
          : null,
      platform: request.platform,
      operation: request.operation,
      request: args.body,
      providerName: args.plan.provider,
      providerEndpoint: args.plan.endpoint,
      estimatedCostUsdMicros: args.estimate.estimatedCostUsdMicros,
      unitPrice: pricing.unitPrice,
      unitSize: pricing.unitSize,
      maxCredits,
      reservedCredits: maxCredits,
    })
    .returning();
  signal.throwIfAborted();
  if (!job) {
    throw new Error("Social data job insertion returned no row");
  }
  return { status: 202, body: publicJob(job) };
}

export const createSocialDataJob$ = command(
  async (
    { get, set },
    args: { readonly auth: Actor; readonly body: SocialDataCreateRequest },
    signal: AbortSignal,
  ): Promise<CreatedResponse | ErrorResponse> => {
    const db = set(writeDb$);
    const disabled = await requireEnabled(db, args.auth, signal);
    if (disabled) {
      return disabled;
    }
    const [existing] = await db
      .select()
      .from(socialDataJobs)
      .where(requestWhere(args.auth, args.body));
    signal.throwIfAborted();
    if (existing) {
      return replayJob(existing, args.body);
    }
    const result = await settle(
      (async () => {
        const plan = prepareSocialDataProviderPlan(requestOf(args.body));
        const estimate = await inspectSocialDataProviderPlan(plan, signal);
        signal.throwIfAborted();
        const resolution = get(usagePricingResolution$);
        return await db.transaction((tx) => {
          return admitJob(tx, { ...args, plan, estimate, resolution }, signal);
        });
      })(),
      signal,
    );
    return result.ok ? result.value : providerErrorResponse(result.error);
  },
);

function claimedWhere(claim: Claim) {
  return and(
    eq(socialDataJobs.id, claim.job.id),
    eq(socialDataJobs.claimExpiresAt, claim.expiresAt),
  );
}

function jobPlan(job: Job): SocialDataProviderPlan {
  const plan = prepareSocialDataProviderPlan(
    requestOf(socialDataCreateRequestSchema.parse(job.request)),
  );
  if (
    plan.provider !== job.providerName ||
    plan.endpoint !== job.providerEndpoint
  ) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_ROUTE_UNAVAILABLE",
      "The saved Social data operation requires support to recover.",
      503,
    );
  }
  return plan;
}

async function finishFree(
  db: Db,
  claim: Claim,
  status: "failed" | "cancelled" | "unknown",
  code?: string,
  message?: string,
): Promise<void> {
  await db
    .update(socialDataJobs)
    .set({
      status,
      creditsCharged: 0,
      reservedCredits: 0,
      error: code && message ? { code, message } : null,
      completedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(claimedWhere(claim));
}

async function readClaimOutcome(
  db: Db,
  claim: Claim,
  signal: AbortSignal,
): Promise<SocialDataProviderRun | null> {
  const job = claim.job;
  const plan = jobPlan(job);
  let outcome: SocialDataProviderRun;
  if (job.startedAt === null) {
    const starting = await db.transaction(async (tx) => {
      if (!(await admitSocialOwner(tx, job))) {
        return undefined;
      }
      signal.throwIfAborted();
      const [admitted] = await tx
        .update(socialDataJobs)
        .set({ status: "running", startedAt: nowDate() })
        .where(and(claimedWhere(claim), isNull(socialDataJobs.stopRequestedAt)))
        .returning();
      return admitted;
    });
    signal.throwIfAborted();
    if (!starting) {
      await finishFree(db, claim, "cancelled");
      return null;
    }
    outcome = await startSocialDataProviderRun(plan, signal);
  } else if (job.upstreamRunId) {
    if (job.stopRequestedAt && !job.stopSubmittedAt) {
      const stopped = await stopSocialDataProviderRun(
        job.upstreamRunId,
        signal,
      );
      if (stopped.acknowledged) {
        await db
          .update(socialDataJobs)
          .set({ stopSubmittedAt: nowDate() })
          .where(claimedWhere(claim));
      }
      signal.throwIfAborted();
    }
    outcome = await readSocialDataProviderRun(plan, job.upstreamRunId, signal);
  } else {
    await finishFree(
      db,
      claim,
      "unknown",
      "SOCIAL_DATA_OUTCOME_UNKNOWN",
      "The operation outcome could not be recovered. This job will not be charged or submitted again.",
    );
    return null;
  }
  if (outcome.upstreamRunId) {
    const [retained] = await db
      .update(socialDataJobs)
      .set({ upstreamRunId: outcome.upstreamRunId })
      .where(claimedWhere(claim))
      .returning({ id: socialDataJobs.id });
    if (!retained) {
      return null;
    }
  }
  signal.throwIfAborted();
  return outcome;
}

async function saveClaimOutcome(
  db: Db,
  claim: Claim,
  outcome: SocialDataProviderRun,
): Promise<Job | null> {
  if (
    outcome.state === "running" ||
    outcome.state === "pending" ||
    (outcome.state === "unknown" && outcome.upstreamRunId)
  ) {
    await db
      .update(socialDataJobs)
      .set({ status: "running", error: null, updatedAt: nowDate() })
      .where(claimedWhere(claim));
    return null;
  }
  if (outcome.state !== "completed") {
    await finishFree(
      db,
      claim,
      outcome.state === "cancelled"
        ? "cancelled"
        : outcome.state === "unknown"
          ? "unknown"
          : "failed",
      outcome.errorCode ?? "SOCIAL_DATA_FAILED",
      "The Social data operation did not produce a billable result.",
    );
    return null;
  }
  if (outcome.actualCostUsdMicros === undefined || !outcome.data) {
    await db
      .update(socialDataJobs)
      .set({
        status: "running",
        error: {
          code: "SOCIAL_DATA_SETTLEMENT_PENDING",
          message: "The result is awaiting a confirmed settlement receipt.",
        },
        updatedAt: nowDate(),
      })
      .where(claimedWhere(claim));
    return null;
  }
  const [saved] = await db
    .update(socialDataJobs)
    .set({
      status: "completed",
      actualCostUsdMicros: outcome.actualCostUsdMicros,
      result: outcome.data,
      error: null,
      updatedAt: nowDate(),
    })
    .where(claimedWhere(claim))
    .returning();
  return saved ?? null;
}

const settleSocialDataJob$ = command(
  async ({ get, set }, claim: Claim, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const resolution = get(usagePricingResolution$);
    const effects = await db.transaction(async (tx) => {
      if (!(await admitSocialOwner(tx, claim.job))) {
        await finishFree(tx, claim, "cancelled");
        return null;
      }
      signal.throwIfAborted();
      await lockUsageEventCompaction(tx, "shared");
      signal.throwIfAborted();
      const [job] = await tx
        .select()
        .from(socialDataJobs)
        .where(claimedWhere(claim))
        .for("update");
      signal.throwIfAborted();
      if (!job || job.creditsCharged !== null) {
        return null;
      }
      if (job.actualCostUsdMicros === null) {
        throw new Error("Completed Social data job has no settlement cost");
      }
      const receipt =
        job.actualCostUsdMicros === 0 || job.maxCredits === 0
          ? null
          : await recordManagedUsageInTransaction(
              tx,
              {
                actor: {
                  orgId: job.orgId,
                  userId: job.userId,
                  ...(job.billingRunId ? { runId: job.billingRunId } : {}),
                },
                resource: {
                  kind: "social",
                  provider: providerFor(job.platform),
                  category: BILLING_CATEGORY,
                  quantity: job.actualCostUsdMicros,
                },
                label: "Okou Social",
                idempotencyKey: job.usageIdempotencyKey,
                pricingSnapshot: {
                  unitPrice: job.unitPrice,
                  unitSize: job.unitSize,
                  creditsLimit: job.maxCredits,
                },
              },
              resolution,
              signal,
            );
      signal.throwIfAborted();
      await tx
        .update(socialDataJobs)
        .set({
          creditsCharged: receipt?.creditsCharged ?? 0,
          reservedCredits: 0,
          completedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(claimedWhere(claim));
      return receipt?.effects ?? null;
    });
    signal.throwIfAborted();
    if (effects) {
      await set(
        completeProcessedOrgUsage$,
        { orgId: claim.job.orgId, result: effects },
        signal,
      );
    }
  },
);

const advanceClaim$ = command(
  async ({ set }, claim: Claim, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    if (claim.job.actualCostUsdMicros === null || claim.job.result === null) {
      const outcome = await readClaimOutcome(db, claim, signal);
      signal.throwIfAborted();
      if (!outcome) {
        return;
      }
      const saved = await saveClaimOutcome(db, claim, outcome);
      signal.throwIfAborted();
      if (!saved) {
        return;
      }
    }
    await set(settleSocialDataJob$, claim, signal);
  },
);

async function handleClaimError(
  db: Db,
  claim: Claim,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!(error instanceof SocialDataProviderError)) {
    throw error;
  }
  const [current] = await db
    .select()
    .from(socialDataJobs)
    .where(claimedWhere(claim));
  signal.throwIfAborted();
  if (current?.upstreamRunId) {
    await db
      .update(socialDataJobs)
      .set({
        error: { code: error.code, message: error.message },
        updatedAt: nowDate(),
      })
      .where(claimedWhere(claim));
  } else {
    await finishFree(
      db,
      claim,
      "unknown",
      "SOCIAL_DATA_OUTCOME_UNKNOWN",
      "The operation outcome could not be confirmed. This job will not be charged or submitted again.",
    );
  }
}

export const advanceSocialDataJob$ = command(
  async ({ set }, jobId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + CLAIM_MS);
    const [job] = await db
      .update(socialDataJobs)
      .set({ claimExpiresAt: expiresAt, updatedAt: now })
      .where(
        and(
          eq(socialDataJobs.id, jobId),
          isNull(socialDataJobs.creditsCharged),
          or(
            isNull(socialDataJobs.claimExpiresAt),
            lt(socialDataJobs.claimExpiresAt, now),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!job) {
      return;
    }
    const claim = { job, expiresAt };
    const result = await settleIncludingAbort(
      (async () => {
        const advanced = await settle(
          set(advanceClaim$, claim, signal),
          signal,
        );
        if (!advanced.ok) {
          await handleClaimError(db, claim, advanced.error, signal);
        }
      })(),
    );
    signal.throwIfAborted();
    await db
      .update(socialDataJobs)
      .set({ claimExpiresAt: null })
      .where(claimedWhere(claim));
    signal.throwIfAborted();
    if (!result.ok) {
      throw result.error;
    }
  },
);

export const getSocialDataJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: SocialDataJobResponse }
    | ErrorResponse
  > => {
    const db = set(writeDb$);
    let job = await findOwnedJob(db, args.auth, args.jobId);
    signal.throwIfAborted();
    if (!job) {
      return errorResponse(404, "NOT_FOUND", "Social data job not found.");
    }
    if (job.creditsCharged === null) {
      await set(advanceSocialDataJob$, job.id, signal);
      signal.throwIfAborted();
      job = await findOwnedJob(db, args.auth, args.jobId);
    }
    if (!job) {
      return errorResponse(404, "NOT_FOUND", "Social data job not found.");
    }
    return { status: 200, body: publicJob(job) };
  },
);

export const listSocialDataJobs$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly query: SocialDataListQuery },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: SocialDataListResponse }
    | ErrorResponse
  > => {
    const db = set(writeDb$);
    const cursor = args.query.cursor
      ? await findOwnedJob(db, args.auth, args.query.cursor)
      : undefined;
    signal.throwIfAborted();
    if (args.query.cursor && !cursor) {
      return errorResponse(404, "NOT_FOUND", "Social data cursor not found.");
    }
    const rows = await db
      .select()
      .from(socialDataJobs)
      .where(
        and(
          eq(socialDataJobs.orgId, args.auth.orgId),
          eq(socialDataJobs.userId, args.auth.userId),
          cursor
            ? or(
                lt(socialDataJobs.createdAt, cursor.createdAt),
                and(
                  eq(socialDataJobs.createdAt, cursor.createdAt),
                  lt(socialDataJobs.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(socialDataJobs.createdAt), desc(socialDataJobs.id))
      .limit(args.query.limit + 1);
    signal.throwIfAborted();
    const jobs = rows.slice(0, args.query.limit);
    return {
      status: 200,
      body: {
        jobs: jobs.map(publicJob),
        nextCursor:
          rows.length > args.query.limit ? (jobs.at(-1)?.id ?? null) : null,
      },
    };
  },
);

export const cancelSocialDataJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: SocialDataJobResponse }
    | ErrorResponse
  > => {
    const db = set(writeDb$);
    await db
      .update(socialDataJobs)
      .set({ stopRequestedAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          ownerWhere(args.auth, args.jobId),
          isNull(socialDataJobs.creditsCharged),
          isNull(socialDataJobs.stopRequestedAt),
        ),
      );
    signal.throwIfAborted();
    return await set(getSocialDataJob$, args, signal);
  },
);

export const reconcileSocialDataJobs$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const jobs = await db
      .select({ id: socialDataJobs.id })
      .from(socialDataJobs)
      .where(
        and(
          isNull(socialDataJobs.creditsCharged),
          or(
            isNull(socialDataJobs.claimExpiresAt),
            lt(socialDataJobs.claimExpiresAt, nowDate()),
          ),
        ),
      )
      .orderBy(socialDataJobs.updatedAt)
      .limit(2);
    signal.throwIfAborted();
    for (const job of jobs) {
      await set(advanceSocialDataJob$, job.id, signal);
      signal.throwIfAborted();
    }
    return jobs.length;
  },
);
