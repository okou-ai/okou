import { creditsFor } from "./social-data-pricing";
import { settleOrgUsage$ } from "./credit-usage-settlement.service";
import { isDeepStrictEqual } from "node:util";

import {
  socialDataCreateRequestSchema,
  socialDataJobResponseSchema,
  type SocialDataCreateRequest,
  type SocialDataProviderCursor,
  type SocialDataJobResponse,
  type SocialDataListQuery,
  type SocialDataListResponse,
  type SocialDataQuoteResponse,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, desc, eq, isNull, lt, or, notInArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { db$, writeDb$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import { completeProcessedOrgUsage$ } from "./credit-usage.service";
import { insufficientCredits } from "./managed-usage.service";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { orgPlanCapabilitySelection } from "./org-plan-entitlement-read.service";
import {
  socialAdmissionBudget,
  socialAdmissionValues,
  socialPricingWhere,
  socialReservationPlan,
  socialCreditCheckArgs,
  managedSnapshotPlan,
  managedSnapshotRequirement,
  managedSnapshotAccess as snapshotAccess,
  memberCreditPlan,
  socialBudgetExceeded,
  socialCapacityExceeded,
  requireSocialPricing,
  hasManagedSnapshotCredits,
} from "./social-data-admission-plan";
import {
  inspectSocialDataProviderPlan,
  readSocialDataProviderRun,
  startSocialDataProviderRun,
  stopSocialDataProviderRun,
  type SocialDataProviderRun,
} from "./social-data-provider";
import {
  prepareSocialDataProviderPlan,
  type SocialDataProviderPlan,
} from "./social-data-provider-catalog";

import { SocialDataProviderError } from "./social-data-provider-error";
import {
  completedSocialDataPage,
  socialDataCollectionView,
} from "./social-data-collection";

export const SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS = 240_000;
const CLAIM_MS = 180_000;
const BILLING_CATEGORY = "provider_cost_usd_micros";
type Actor = AuthContext & { readonly orgId: string };
type Job = typeof socialDataJobs.$inferSelect;
type ErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503;
export interface ErrorResponse {
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

function socialContinuationConflict(): ErrorResponse {
  return errorResponse(
    409,
    "SOCIAL_DATA_PAGE_ALREADY_CONTINUED",
    "This page already has a continuation. Recover it from saved jobs; do not submit it again.",
  );
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

function publicJob(job: Job): SocialDataJobResponse {
  return socialDataJobResponseSchema.parse({
    jobId: job.id,
    requestId: job.requestId,
    platform: job.platform,
    operation: job.operation,
    status: job.status,
    data: job.result,
    collection: socialDataCollectionView(job),
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

function ownerWhere(auth: Pick<Actor, "orgId" | "userId">, jobId: string) {
  return and(
    eq(socialDataJobs.id, jobId),
    eq(socialDataJobs.orgId, auth.orgId),
    eq(socialDataJobs.userId, auth.userId),
  );
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
  sourceJobId: string | null = null,
): CreatedResponse | ErrorResponse {
  return job.sourceJobId === sourceJobId && isDeepStrictEqual(job.request, body)
    ? { status: 202, body: publicJob(job) }
    : errorResponse(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This request ID belongs to different Social inputs.",
      );
}

export const quoteSocialData$ = command(
  async (
    { get },
    args: {
      readonly auth: Actor;
      readonly body: SocialDataRequest;
      readonly cursor?: SocialDataProviderCursor;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: SocialDataQuoteResponse }
    | ErrorResponse
  > => {
    const db = get(db$);
    const result = await settle(
      (async () => {
        const estimate = await inspectSocialDataProviderPlan(
          prepareSocialDataProviderPlan(args.body, args.cursor),
          signal,
        );
        signal.throwIfAborted();
        const provider = providerFor(args.body.platform);
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

interface SocialAdmissionArgs {
  readonly auth: Actor;
  readonly body: SocialDataCreateRequest;
  readonly source?: Job;
}

async function prepareSocialAdmission(
  args: SocialAdmissionArgs,
  signal: AbortSignal,
) {
  const plan = prepareSocialDataProviderPlan(
    requestOf(args.body),
    args.source?.nextProviderCursor ?? undefined,
  );
  const estimate = await inspectSocialDataProviderPlan(plan, signal);
  signal.throwIfAborted();
  return { plan, estimate };
}

const checkSocialDataAdmission$ = command(
  async (
    { get },
    args: SocialAdmissionArgs,
    signal: AbortSignal,
  ): Promise<CreatedResponse | ErrorResponse | null> => {
    const db = get(db$);
    const [existing] = await db
      .select()
      .from(socialDataJobs)
      .where(requestWhere(args.auth, args.body));
    signal.throwIfAborted();
    if (existing) {
      return replayJob(existing, args.body, args.source?.id ?? null);
    }
    if (args.source) {
      const [successor] = await db
        .select({ id: socialDataJobs.id })
        .from(socialDataJobs)
        .where(eq(socialDataJobs.sourceJobId, args.source.id));
      signal.throwIfAborted();
      if (successor) {
        return socialContinuationConflict();
      }
    }
    return null;
  },
);

const reserveSocialDataJob$ = command(
  async (
    { set },
    args: SocialAdmissionArgs,
    signal: AbortSignal,
  ): Promise<CreatedResponse | ErrorResponse> => {
    const db = set(writeDb$);
    const result = await settle(
      (async () => {
        const { plan, estimate } = await prepareSocialAdmission(args, signal);
        const orgId = args.auth.orgId;
        // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0249; new non-billing transactions are prohibited.
        return await db.transaction(async (tx) => {
          const [owner] = await tx
            .select({ orgId: orgMetadata.orgId })
            .from(orgMetadata)
            .where(eq(orgMetadata.orgId, orgId))
            .for("no key update");
          signal.throwIfAborted();
          if (!owner) {
            return errorResponse(404, "NOT_FOUND", "Organization not found.");
          }
          const [duplicate] = await tx
            .select()
            .from(socialDataJobs)
            .where(requestWhere(args.auth, args.body));
          signal.throwIfAborted();
          if (duplicate) {
            return replayJob(duplicate, args.body, args.source?.id ?? null);
          }
          if (args.source) {
            const [successor] = await tx
              .select({ id: socialDataJobs.id })
              .from(socialDataJobs)
              .where(eq(socialDataJobs.sourceJobId, args.source.id));
            signal.throwIfAborted();
            if (successor) {
              return socialContinuationConflict();
            }
          }
          const request = requestOf(args.body);
          const [pricing] = await tx
            .select()
            .from(usagePricing)
            .where(socialPricingWhere(request.platform))
            .for("share");
          const price = requireSocialPricing(pricing);
          signal.throwIfAborted();
          const budget = socialAdmissionBudget(args.body, estimate, price);
          if (budget.maxCredits < budget.estimatedCredits) {
            return socialBudgetExceeded();
          }
          const reservationPlan = socialReservationPlan(orgId);
          const [reservation] = await tx
            .select(reservationPlan.columns)
            .from(socialDataJobs)
            .where(reservationPlan.where);
          signal.throwIfAborted();
          if ((reservation?.jobs ?? 0) >= 100) {
            return socialCapacityExceeded();
          }
          if (budget.maxCredits !== 0) {
            const creditArgs = socialCreditCheckArgs(
              args.auth,
              request,
              estimate,
              budget,
              reservation,
            );
            const snapshotPlan = managedSnapshotPlan(creditArgs);
            const [snapshot] = await tx
              .with(snapshotPlan.expired)
              .select(snapshotPlan.columns)
              .from(snapshotPlan.expired)
              .leftJoin(orgMetadata, snapshotPlan.orgWhere)
              .leftJoin(usagePricing, snapshotPlan.pricingWhere);
            signal.throwIfAborted();
            const required = managedSnapshotRequirement(snapshot, creditArgs);
            if ("status" in required) {
              return required;
            }
            const [capabilities] = await tx
              .select(orgPlanCapabilitySelection())
              .from(orgPlanEntitlements)
              .where(eq(orgPlanEntitlements.orgId, orgId))
              .limit(1);
            if (!capabilities) {
              const [org] = await tx
                .select({ orgId: orgMetadata.orgId })
                .from(orgMetadata)
                .where(eq(orgMetadata.orgId, orgId))
                .limit(1);
              if (org) {
                throw new Error(`Missing org plan entitlement for ${orgId}`);
              }
            }
            const access = snapshotAccess(required.row, capabilities, orgId);
            signal.throwIfAborted();
            if (access !== "paid" && access !== "free") {
              return access;
            }
            if (access === "paid") {
              const memberPlan = memberCreditPlan(creditArgs, nowDate());
              const [member] = await tx
                .select(memberPlan.columns)
                .from(usagePackCreditGrants)
                .where(memberPlan.where);
              signal.throwIfAborted();
              if (!hasManagedSnapshotCredits(required, member)) {
                return insufficientCredits();
              }
            }
          }
          const [job] = await tx
            .insert(socialDataJobs)
            .values(socialAdmissionValues({ ...args, plan, estimate }, budget))
            .returning();
          signal.throwIfAborted();
          // Publish the financial reservation against the wallet version too,
          // so concurrent Data Search admission CAS cannot accept an old budget.
          await tx
            .update(orgMetadata)
            .set({ updatedAt: nowDate() })
            .where(eq(orgMetadata.orgId, orgId));
          return createdSocialDataJob(job);
        });
      })(),
      signal,
    );
    return result.ok ? result.value : providerErrorResponse(result.error);
  },
);

export const createSocialDataJob$ = command(
  async (
    { set },
    args: SocialAdmissionArgs,
    signal: AbortSignal,
  ): Promise<CreatedResponse | ErrorResponse> => {
    const existing = await set(checkSocialDataAdmission$, args, signal);
    return existing ?? (await set(reserveSocialDataJob$, args, signal));
  },
);

function createdSocialDataJob(job: Job | undefined): CreatedResponse {
  if (!job) {
    throw new Error("Social data job insertion returned no row");
  }
  return { status: 202, body: publicJob(job) };
}

function claimedWhere(claim: Claim) {
  return and(
    eq(socialDataJobs.id, claim.job.id),
    eq(socialDataJobs.claimExpiresAt, claim.expiresAt),
  );
}

function jobPlan(job: Job): SocialDataProviderPlan {
  const plan = prepareSocialDataProviderPlan(
    requestOf(socialDataCreateRequestSchema.parse(job.request)),
    job.providerCursor ?? undefined,
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

const finishFree$ = command(
  async (
    { set },
    claim: Claim,
    status: "failed" | "cancelled" | "unknown",
    code?: string,
    message?: string,
  ): Promise<void> => {
    const db = set(writeDb$);
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
  },
);

const readClaimOutcome$ = command(
  async (
    { set },
    claim: Claim,
    signal: AbortSignal,
  ): Promise<SocialDataProviderRun | null> => {
    const db = set(writeDb$);
    const job = claim.job;
    const plan = jobPlan(job);
    let outcome: SocialDataProviderRun;
    if (job.startedAt === null) {
      const [starting] = await db
        .update(socialDataJobs)
        .set({ status: "running", startedAt: nowDate() })
        .where(and(claimedWhere(claim), isNull(socialDataJobs.stopRequestedAt)))
        .returning();
      signal.throwIfAborted();
      if (!starting) {
        await set(finishFree$, claim, "cancelled");
        signal.throwIfAborted();
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
      outcome = await readSocialDataProviderRun(
        plan,
        job.upstreamRunId,
        signal,
      );
    } else {
      await set(
        finishFree$,
        claim,
        "unknown",
        "SOCIAL_DATA_OUTCOME_UNKNOWN",
        "The operation outcome could not be recovered. This job will not be charged or submitted again.",
      );
      signal.throwIfAborted();
      return null;
    }
    if (outcome.upstreamRunId) {
      const [retained] = await db
        .update(socialDataJobs)
        .set({ upstreamRunId: outcome.upstreamRunId })
        .where(claimedWhere(claim))
        .returning({ id: socialDataJobs.id });
      signal.throwIfAborted();
      if (!retained) {
        return null;
      }
    }
    signal.throwIfAborted();
    return outcome;
  },
);

const saveClaimOutcome$ = command(
  async (
    { set },
    claim: Claim,
    outcome: SocialDataProviderRun,
  ): Promise<Job | null> => {
    const db = set(writeDb$);
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
      await set(
        finishFree$,
        claim,
        outcome.state === "cancelled"
          ? "cancelled"
          : outcome.state === "unknown"
            ? "unknown"
            : "failed",
        outcome.errorCode ?? "SOCIAL_DATA_FAILED",
        outcome.errorMessage ??
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
        ...completedSocialDataPage(claim.job, outcome),
        error: null,
        updatedAt: nowDate(),
      })
      .where(claimedWhere(claim))
      .returning();
    return saved ?? null;
  },
);

const settleSocialDataJob$ = command(
  async ({ set }, claim: Claim, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const [current] = await db
      .select({
        creditsCharged: socialDataJobs.creditsCharged,
      })
      .from(socialDataJobs)
      .where(claimedWhere(claim));
    signal.throwIfAborted();
    if (!current || current.creditsCharged !== null) {
      return;
    }
    const effects = await set(
      settleOrgUsage$,
      {
        orgId: claim.job.orgId,
        social: { jobId: claim.job.id, expiresAt: claim.expiresAt },
      },
      signal,
    );
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
    if (claim.job.actualCostUsdMicros === null || claim.job.result === null) {
      const outcome = await set(readClaimOutcome$, claim, signal);
      signal.throwIfAborted();
      if (!outcome) {
        return;
      }
      const saved = await set(saveClaimOutcome$, claim, outcome);
      signal.throwIfAborted();
      if (!saved) {
        return;
      }
    }
    await set(settleSocialDataJob$, claim, signal);
  },
);

const handleClaimError$ = command(
  async (
    { set },
    claim: Claim,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
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
      await set(
        finishFree$,
        claim,
        "unknown",
        "SOCIAL_DATA_OUTCOME_UNKNOWN",
        "The operation outcome could not be confirmed. This job will not be charged or submitted again.",
      );
    }
  },
);

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
          await set(handleClaimError$, claim, advanced.error, signal);
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
    const initialAuth = args.auth;
    const initialJobId = args.jobId;
    let job = await (async (): Promise<Job | undefined> => {
      const [owned] = await db
        .select()
        .from(socialDataJobs)
        .where(ownerWhere(initialAuth, initialJobId));
      return owned;
    })();
    signal.throwIfAborted();
    if (!job) {
      return errorResponse(404, "NOT_FOUND", "Social data job not found.");
    }
    if (job.creditsCharged === null) {
      await set(advanceSocialDataJob$, job.id, signal);
      signal.throwIfAborted();
      const refreshedAuth = args.auth;
      const refreshedJobId = args.jobId;
      job = await (async (): Promise<Job | undefined> => {
        const [owned] = await db
          .select()
          .from(socialDataJobs)
          .where(ownerWhere(refreshedAuth, refreshedJobId));
        return owned;
      })();
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
    const cursorLookup = args.query.cursor
      ? { auth: args.auth, jobId: args.query.cursor }
      : undefined;
    const cursor = cursorLookup
      ? await (async (): Promise<Job | undefined> => {
          const [owned] = await db
            .select()
            .from(socialDataJobs)
            .where(ownerWhere(cursorLookup.auth, cursorLookup.jobId));
          return owned;
        })()
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
          args.query.includeExpanded
            ? undefined
            : and(
                notInArray(socialDataJobs.platform, ["douyin", "weibo"]),
                notInArray(socialDataJobs.operation, [
                  "replies",
                  "followers",
                  "following",
                ]),
              ),
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
