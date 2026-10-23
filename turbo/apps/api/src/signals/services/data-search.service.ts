import { isDeepStrictEqual } from "node:util";
import {
  dataSearchJobResponseSchema,
  type DataSearchCreateRequest,
  type DataSearchRequest,
  type DataSearchJobResponse,
  type DataSearchListQuery,
} from "@okouai/api-contracts/contracts/data-search";
import { dataSearchJobs } from "@okouai/db/schema/data-search-job";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command, computed } from "ccstate";
import { and, desc, eq, isNull, isNotNull, lt, or, sql, ne } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { AuthContext } from "../../types/auth";
import { db$, writeDb$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import {
  quoteDataSearchProvider,
  startDataSearchProvider,
  readDataSearchProvider,
  stopDataSearchProvider,
  type DataSearchProviderRun,
} from "./data-search-provider";
import { DataSearchProviderError } from "./data-search-provider-error";
import { creditsFor } from "./social-data-pricing";
import {
  dataSearchLedgerProvider,
  listDataSearchCapabilities,
  reviewedDataSearchCapability,
} from "./data-search-catalog";
import {
  managedSnapshotPlan,
  managedSnapshotRequirement,
  managedSnapshotAccess,
  memberCreditPlan,
  hasManagedSnapshotCredits,
} from "./social-data-admission-plan";
import { officialWorkflowCreditAccess$ } from "./official-workflow-policy.service";
import { orgPlanCapabilitySelection } from "./org-plan-entitlement-read.service";
import { insufficientCredits } from "./managed-usage.service";
import { settleOrgUsage$ } from "./credit-usage-settlement.service";
import { completeProcessedOrgUsage$ } from "./credit-usage.service";
import {
  dataReservationPlan,
  socialReservationPlan,
  dataAdmissionCreditArgs,
  dataAdmissionValues,
  dataRequestConflictTarget,
  requireAdmissionValue,
  DataSearchAdmissionConflict,
  type DataSearchAdmission,
} from "./data-search-admission-plan";

type Actor = AuthContext & { readonly orgId: string };
type Job = typeof dataSearchJobs.$inferSelect;
type ErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503;
export function dataSearchError(
  status: ErrorStatus,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
function providerError(error: unknown) {
  if (error instanceof DataSearchProviderError) {
    return dataSearchError(error.status, error.code, error.message);
  }
  throw error;
}
function enrichmentAccessWhere(auth: Actor) {
  return auth.tokenType === "agent" &&
    !auth.capabilities.includes("data-enrichment:read")
    ? ne(dataSearchJobs.capability, "people.enrich")
    : undefined;
}
function ownerWhere(auth: Actor, jobId: string) {
  return and(
    eq(dataSearchJobs.id, jobId),
    eq(dataSearchJobs.orgId, auth.orgId),
    eq(dataSearchJobs.userId, auth.userId),
    enrichmentAccessWhere(auth),
  );
}
function requestWhere(auth: Actor, requestId: string) {
  return and(
    eq(dataSearchJobs.orgId, auth.orgId),
    eq(dataSearchJobs.userId, auth.userId),
    eq(dataSearchJobs.requestId, requestId),
  );
}
function publicJob(job: Job): DataSearchJobResponse {
  return dataSearchJobResponseSchema.parse({
    jobId: job.id,
    requestId: job.requestId,
    capability: job.capability,
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
function replay(job: Job, body: DataSearchCreateRequest) {
  return isDeepStrictEqual(job.request, body)
    ? { status: 202 as const, body: publicJob(job) }
    : dataSearchError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This request ID belongs to different Data Search inputs.",
      );
}
function pricingUnavailable() {
  return dataSearchError(
    503,
    "PRICING_NOT_CONFIGURED",
    "Data Search pricing is unavailable.",
  );
}
function pricingWhere(provider: string) {
  return and(
    eq(usagePricing.kind, "data-search"),
    eq(usagePricing.provider, provider),
    eq(usagePricing.category, "provider_cost_usd_micros"),
  );
}

function validateAdmissionPrice(
  args: DataSearchAdmission,
  price: typeof usagePricing.$inferSelect,
) {
  if (
    args.estimate.plan.vendor === "firecrawl" &&
    args.estimate.plan.sourceCostUsdMicrosPerCredit !==
      price.sourceCostUsdMicrosPerCredit
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_PRICING_CHANGED",
      "Data Search pricing changed. Obtain a fresh quote and retry this request ID.",
      409,
    );
  }
  const estimated = creditsFor(
    args.estimate.estimatedCostUsdMicros,
    price.unitPrice,
    price.unitSize,
  );
  if (estimated > args.body.maxCredits) {
    throw new DataSearchProviderError(
      "BUDGET_EXCEEDED",
      "The estimated cost exceeds maxCredits.",
      402,
    );
  }
}

export const dataSearchCapabilities$ = computed(async (get) => {
  const prices = await get(db$)
    .select({ provider: usagePricing.provider })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "data-search"),
        eq(usagePricing.category, "provider_cost_usd_micros"),
        isNotNull(usagePricing.sourceCostUsdMicrosPerCredit),
      ),
    );
  return listDataSearchCapabilities(
    new Set(
      prices.map((price) => {
        return price.provider;
      }),
    ),
  );
});

const prepareDataSearchQuote$ = command(
  async ({ get }, input: DataSearchRequest, signal: AbortSignal) => {
    const capability = reviewedDataSearchCapability(
      input.capability,
      input.input,
    );
    const [price] = await get(db$)
      .select()
      .from(usagePricing)
      .where(pricingWhere(dataSearchLedgerProvider(capability)));
    signal.throwIfAborted();
    if (!price) {
      throw new DataSearchProviderError(
        "PRICING_NOT_CONFIGURED",
        "Data Search pricing is unavailable.",
        503,
      );
    }
    const estimate = await quoteDataSearchProvider(
      input,
      price.sourceCostUsdMicrosPerCredit ?? undefined,
      signal,
    );
    return { estimate, price };
  },
);

export const quoteDataSearch$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly body: DataSearchRequest },
    signal: AbortSignal,
  ) => {
    const result = await settle(
      (async () => {
        const { estimate, price } = await set(
          prepareDataSearchQuote$,
          args.body,
          signal,
        );
        const credits = creditsFor(
          estimate.estimatedCostUsdMicros,
          price.unitPrice,
          price.unitSize,
        );
        return {
          status: 200 as const,
          body: {
            capability: args.body.capability,
            estimatedCredits: credits,
            maxCredits: credits,
            quantity: estimate.quantity,
            unit: estimate.unit,
          },
        };
      })(),
      signal,
    );
    return result.ok ? result.value : providerError(result.error);
  },
);

const reserveDataSearchJob$ = command(
  async ({ set }, args: DataSearchAdmission, signal: AbortSignal) => {
    // Validate the wallet before reading capacity so READ COMMITTED observes
    // grant-only settlement, which leaves wallet xmin unchanged. This normal
    // update owns admission through reservation commit.
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: job reservation and wallet version validation must commit together; single-statement alternative: entitlement, expired-credit and member-grant validation need a dependent snapshot with whole-reservation rollback on a changed wallet.
    return await set(writeDb$).transaction(async (tx) => {
      const [wallet] = await tx
        .select({
          xmin: sql`${orgMetadata}.xmin::text`.mapWith(pgTextDecoder),
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.auth.orgId));
      if (!wallet) {
        return dataSearchError(404, "NOT_FOUND", "Organization not found.");
      }
      const [duplicate] = await tx
        .select()
        .from(dataSearchJobs)
        .where(requestWhere(args.auth, args.body.requestId));
      if (duplicate) {
        return replay(duplicate, args.body);
      }
      const [price] = await tx
        .select()
        .from(usagePricing)
        .where(pricingWhere(args.providerName));
      if (!price) {
        return pricingUnavailable();
      }
      validateAdmissionPrice(args, price);
      const [validated] = await tx
        .update(orgMetadata)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            eq(orgMetadata.orgId, args.auth.orgId),
            sql`${orgMetadata}.xmin::text = ${wallet.xmin}`,
          ),
        )
        .returning({ orgId: orgMetadata.orgId });
      requireAdmissionValue(validated);
      const reservations = dataReservationPlan(args.auth.orgId);
      const socialReservations = socialReservationPlan(args.auth.orgId);
      const [reservation] = await tx
        .select(reservations.columns)
        .from(dataSearchJobs)
        .where(reservations.where);
      const [socialReservation] = await tx
        .select(socialReservations.columns)
        .from(socialDataJobs)
        .where(socialReservations.where);
      if (!reservation || !socialReservation) {
        throw new Error("Data Search reservation aggregate returned no row");
      }
      if (reservation.jobs >= 100) {
        return dataSearchError(
          429,
          "DATA_SEARCH_CAPACITY",
          "Wait for existing Data Search jobs to finish.",
        );
      }
      if (args.body.maxCredits > 0) {
        const creditArgs = dataAdmissionCreditArgs(
          args,
          price,
          reservation.credits + socialReservation.credits,
        );
        const snapshotPlan = managedSnapshotPlan(creditArgs);
        const [snapshot] = await tx
          .with(snapshotPlan.expired)
          .select(snapshotPlan.columns)
          .from(snapshotPlan.expired)
          .leftJoin(orgMetadata, snapshotPlan.orgWhere)
          .leftJoin(usagePricing, snapshotPlan.pricingWhere);
        const requirement = managedSnapshotRequirement(snapshot, creditArgs);
        if ("status" in requirement) {
          return requirement;
        }
        const [capabilities] = await tx
          .select(orgPlanCapabilitySelection())
          .from(orgPlanEntitlements)
          .where(eq(orgPlanEntitlements.orgId, args.auth.orgId))
          .limit(1);
        if (!capabilities) {
          throw new Error(
            `Missing org plan entitlement for ${args.auth.orgId}`,
          );
        }
        const access = managedSnapshotAccess(
          requirement.row,
          capabilities,
          args.auth.orgId,
        );
        if (access !== "paid" && access !== "free") {
          return access;
        }
        if (access === "paid") {
          const memberPlan = memberCreditPlan(creditArgs, nowDate());
          const [member] = await tx
            .select(memberPlan.columns)
            .from(usagePackCreditGrants)
            .where(memberPlan.where);
          if (!hasManagedSnapshotCredits(requirement, member)) {
            return insufficientCredits();
          }
        }
      }
      const [job] = await tx
        .insert(dataSearchJobs)
        .values(dataAdmissionValues(args, price))
        .onConflictDoNothing({ target: dataRequestConflictTarget() })
        .returning();
      const inserted = requireAdmissionValue(job);
      signal.throwIfAborted();
      return { status: 202 as const, body: publicJob(inserted) };
    });
  },
);

export const createDataSearchJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly body: DataSearchCreateRequest },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [existing] = await db
      .select()
      .from(dataSearchJobs)
      .where(requestWhere(args.auth, args.body.requestId));
    signal.throwIfAborted();
    if (existing) {
      return replay(existing, args.body);
    }
    const result = await settle(
      (async () => {
        const {
          requestId: _requestId,
          maxCredits: _maxCredits,
          ...request
        } = args.body;
        const { estimate } = await set(
          prepareDataSearchQuote$,
          request,
          signal,
        );
        return await set(
          reserveDataSearchJob$,
          {
            ...args,
            estimate,
            providerName: dataSearchLedgerProvider(estimate.plan),
          },
          signal,
        );
      })(),
      signal,
    );
    if (!result.ok && result.error instanceof DataSearchAdmissionConflict) {
      const [duplicate] = await db
        .select()
        .from(dataSearchJobs)
        .where(requestWhere(args.auth, args.body.requestId));
      signal.throwIfAborted();
      return duplicate
        ? replay(duplicate, args.body)
        : dataSearchError(
            409,
            "DATA_SEARCH_ADMISSION_CHANGED",
            "Credit capacity changed. Obtain a fresh quote and retry this request ID.",
          );
    }
    return result.ok ? result.value : providerError(result.error);
  },
);

const saveDataSearchOutcome$ = command(
  async (
    { set },
    job: Job,
    outcome: DataSearchProviderRun,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // Concurrent readers may reconcile, but only the first confirmed cost/result
    // becomes immutable. Settlement performs a separate receipt CAS with debit.
    const finished =
      outcome.state === "completed" ||
      outcome.state === "failed" ||
      outcome.state === "cancelled";
    const cost = outcome.actualCostUsdMicros;
    if (cost !== undefined && (!Number.isSafeInteger(cost) || cost < 0)) {
      throw new Error("Invalid Data Search provider settlement cost");
    }
    const [saved] = await db
      .update(dataSearchJobs)
      .set({
        upstreamRunId: outcome.upstreamRunId ?? job.upstreamRunId,
        status: outcome.state,
        result: outcome.data ?? job.result,
        actualCostUsdMicros: finished && cost !== undefined ? cost : null,
        error:
          outcome.errorCode !== undefined
            ? {
                code: outcome.errorCode,
                message: outcome.errorMessage,
              }
            : finished && cost === undefined
              ? {
                  code: "DATA_SEARCH_SETTLEMENT_PENDING",
                  message: "Awaiting a confirmed source cost receipt.",
                }
              : null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(dataSearchJobs.id, job.id),
          isNull(dataSearchJobs.creditsCharged),
          isNull(dataSearchJobs.actualCostUsdMicros),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return saved;
  },
);

// Submission owns a bounded lifetime independent of a reader/disconnect. Once
// source acceptance is attempted, persist its receipt before honoring timeout.
const submitDataSearchJob$ = command(async ({ set }, job: Job) => {
  const signal = AbortSignal.timeout(240_000);
  const db = set(writeDb$);
  const started = await settleIncludingAbort(
    startDataSearchProvider(job.plan, job.requestId, signal),
  );
  if (started.ok) {
    await set(saveDataSearchOutcome$, job, started.value, signal);
    return started.value;
  }
  const unsubmitted =
    started.error instanceof DataSearchProviderError ||
    (signal.aborted && started.error === signal.reason);
  await db
    .update(dataSearchJobs)
    .set({
      status: unsubmitted ? "failed" : "unknown",
      ...(unsubmitted
        ? { creditsCharged: 0, reservedCredits: 0, completedAt: nowDate() }
        : {}),
      error: {
        code:
          started.error instanceof DataSearchProviderError
            ? started.error.code
            : unsubmitted
              ? "DATA_SEARCH_NOT_SUBMITTED"
              : "DATA_SEARCH_OUTCOME_UNKNOWN",
        message:
          started.error instanceof DataSearchProviderError
            ? started.error.message
            : unsubmitted
              ? "Execution was cancelled before source submission."
              : "Source acceptance is uncertain. No automatic replay or refund is safe; contact support with this job ID. Credits remain reserved.",
      },
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(dataSearchJobs.id, job.id),
        isNull(dataSearchJobs.upstreamRunId),
        isNull(dataSearchJobs.actualCostUsdMicros),
        isNull(dataSearchJobs.creditsCharged),
      ),
    );
  return null;
});

const startDataSearchJob$ = command(
  async ({ set }, job: Job, signal: AbortSignal) => {
    const db = set(writeDb$);
    const access = await set(
      officialWorkflowCreditAccess$,
      {
        runId: job.billingRunId ?? undefined,
        orgId: job.orgId,
        userId: job.userId,
      },
      signal,
    );
    if (access === "closed") {
      await db
        .update(dataSearchJobs)
        .set({
          status: "failed",
          creditsCharged: 0,
          reservedCredits: 0,
          completedAt: nowDate(),
          updatedAt: nowDate(),
          error: {
            code: "RESOURCE_UNAVAILABLE",
            message:
              "The original Official Workflow run ended before execution.",
          },
        })
        .where(
          and(
            eq(dataSearchJobs.id, job.id),
            isNull(dataSearchJobs.startedAt),
            isNull(dataSearchJobs.creditsCharged),
          ),
        );
      signal.throwIfAborted();
      return null;
    }
    signal.throwIfAborted();
    const [starting] = await db
      .update(dataSearchJobs)
      .set({ status: "running", startedAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          eq(dataSearchJobs.id, job.id),
          isNull(dataSearchJobs.startedAt),
          isNull(dataSearchJobs.creditsCharged),
          isNull(dataSearchJobs.stopRequestedAt),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!starting) {
      return null;
    }
    return await set(submitDataSearchJob$, starting);
  },
);

const advanceDataSearchJobOnce$ = command(
  async ({ set }, jobId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const [job] = await db
      .select()
      .from(dataSearchJobs)
      .where(
        and(
          eq(dataSearchJobs.id, jobId),
          isNull(dataSearchJobs.creditsCharged),
        ),
      );
    signal.throwIfAborted();
    if (!job) {
      return;
    }
    if (job.actualCostUsdMicros === null) {
      let outcome: DataSearchProviderRun;
      if (job.startedAt === null) {
        const submitted = await set(startDataSearchJob$, job, signal);
        if (!submitted) {
          return;
        }
        outcome = submitted;
      } else if (job.upstreamRunId) {
        // A read never starts another paid operation.
        const [stop] =
          job.stopRequestedAt && !job.stopSubmittedAt
            ? await db
                .update(dataSearchJobs)
                .set({ stopSubmittedAt: nowDate(), updatedAt: nowDate() })
                .where(
                  and(
                    eq(dataSearchJobs.id, job.id),
                    isNull(dataSearchJobs.stopSubmittedAt),
                    isNull(dataSearchJobs.actualCostUsdMicros),
                    isNull(dataSearchJobs.creditsCharged),
                  ),
                )
                .returning()
            : [];
        if (stop) {
          await stopDataSearchProvider(job.plan, job.upstreamRunId, signal);
        }
        outcome = await readDataSearchProvider(
          job.plan,
          job.upstreamRunId,
          signal,
        );
      } else {
        if (
          nowDate().getTime() - job.startedAt.getTime() >= 240_000 &&
          job.status !== "unknown"
        ) {
          await db
            .update(dataSearchJobs)
            .set({
              status: "unknown",
              updatedAt: nowDate(),
              error: {
                code: "DATA_SEARCH_ACCEPTANCE_UNCONFIRMED",
                message:
                  "Source acceptance was not recorded. No automatic replay or refund is safe. Contact support with this job ID for source reconciliation; credits remain reserved.",
              },
            })
            .where(
              and(
                eq(dataSearchJobs.id, job.id),
                isNull(dataSearchJobs.upstreamRunId),
                isNull(dataSearchJobs.actualCostUsdMicros),
                isNull(dataSearchJobs.creditsCharged),
              ),
            );
        }
        return;
      }
      // Persist a received identity/receipt even when the request owner timed out.
      await set(saveDataSearchOutcome$, job, outcome, signal);
      if (
        outcome.upstreamRunId &&
        (outcome.state === "pending" || outcome.state === "running")
      ) {
        const [stop] = await db
          .update(dataSearchJobs)
          .set({ stopSubmittedAt: nowDate(), updatedAt: nowDate() })
          .where(
            and(
              eq(dataSearchJobs.id, job.id),
              isNotNull(dataSearchJobs.stopRequestedAt),
              isNull(dataSearchJobs.stopSubmittedAt),
              isNull(dataSearchJobs.actualCostUsdMicros),
              isNull(dataSearchJobs.creditsCharged),
            ),
          )
          .returning();
        signal.throwIfAborted();
        if (stop) {
          await stopDataSearchProvider(job.plan, outcome.upstreamRunId, signal);
        }
      }
    }
    const [settleable] = await db
      .select()
      .from(dataSearchJobs)
      .where(
        and(
          eq(dataSearchJobs.id, jobId),
          isNull(dataSearchJobs.creditsCharged),
        ),
      );
    signal.throwIfAborted();
    if (
      settleable?.actualCostUsdMicros !== null &&
      settleable?.actualCostUsdMicros !== undefined
    ) {
      const effects = await set(
        settleOrgUsage$,
        { orgId: settleable.orgId, dataSearchJobId: jobId },
        signal,
      );
      if (effects) {
        await set(
          completeProcessedOrgUsage$,
          { orgId: settleable.orgId, result: effects },
          signal,
        );
      }
    }
  },
);

export const advanceDataSearchJob$ = command(
  async ({ set }, jobId: string, signal: AbortSignal): Promise<void> => {
    const advanced = await settle(
      set(advanceDataSearchJobOnce$, jobId, signal),
      signal,
    );
    if (advanced.ok) {
      return;
    }
    if (
      !(advanced.error instanceof DataSearchProviderError) ||
      ![
        "DATA_SEARCH_UNAVAILABLE",
        "DATA_SEARCH_INVALID_RESPONSE",
        "DATA_SEARCH_INVALID_BILLING",
        "DATA_SEARCH_CANCEL_UNKNOWN",
      ].includes(advanced.error.code)
    ) {
      throw advanced.error;
    }
    // A source failure leaves the liability intact, but this attempt must not
    // monopolize the global oldest-first reconciler. Local/DB failures propagate.
    await set(writeDb$)
      .update(dataSearchJobs)
      .set({
        error: { code: advanced.error.code, message: advanced.error.message },
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(dataSearchJobs.id, jobId),
          isNull(dataSearchJobs.creditsCharged),
          isNull(dataSearchJobs.actualCostUsdMicros),
        ),
      );
    signal.throwIfAborted();
  },
);

export const getDataSearchJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [job] = await db
      .select()
      .from(dataSearchJobs)
      .where(ownerWhere(args.auth, args.jobId));
    signal.throwIfAborted();
    if (!job) {
      return dataSearchError(404, "NOT_FOUND", "Data Search job not found.");
    }
    return { status: 200 as const, body: publicJob(job) };
  },
);
export const listDataSearchJobs$ = command(
  async (
    { get },
    args: { readonly auth: Actor; readonly query: DataSearchListQuery },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [cursor] = args.query.cursor
      ? await db
          .select()
          .from(dataSearchJobs)
          .where(ownerWhere(args.auth, args.query.cursor))
      : [];
    if (args.query.cursor && !cursor) {
      return dataSearchError(404, "NOT_FOUND", "Data Search cursor not found.");
    }
    const rows = await db
      .select()
      .from(dataSearchJobs)
      .where(
        and(
          eq(dataSearchJobs.orgId, args.auth.orgId),
          eq(dataSearchJobs.userId, args.auth.userId),
          enrichmentAccessWhere(args.auth),
          args.query.status
            ? eq(dataSearchJobs.status, args.query.status)
            : undefined,
          cursor
            ? or(
                lt(dataSearchJobs.createdAt, cursor.createdAt),
                and(
                  eq(dataSearchJobs.createdAt, cursor.createdAt),
                  lt(dataSearchJobs.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(dataSearchJobs.createdAt), desc(dataSearchJobs.id))
      .limit(args.query.limit + 1);
    signal.throwIfAborted();
    const jobs = rows.slice(0, args.query.limit);
    let nextCursor: string | null = null;
    if (rows.length > args.query.limit) {
      const last = jobs.at(-1);
      if (!last) {
        throw new Error("Data Search next page has no cursor row");
      }
      nextCursor = last.id;
    }
    return {
      status: 200 as const,
      body: {
        jobs: jobs.map(publicJob),
        nextCursor,
      },
    };
  },
);
export const cancelDataSearchJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [cancelled] = await db
      .update(dataSearchJobs)
      .set({
        status: "cancelled",
        stopRequestedAt: nowDate(),
        creditsCharged: 0,
        reservedCredits: 0,
        completedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          ownerWhere(args.auth, args.jobId),
          isNull(dataSearchJobs.startedAt),
          isNull(dataSearchJobs.creditsCharged),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (cancelled) {
      return { status: 200 as const, body: publicJob(cancelled) };
    }
    await db
      .update(dataSearchJobs)
      .set({ stopRequestedAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          ownerWhere(args.auth, args.jobId),
          isNull(dataSearchJobs.creditsCharged),
          isNull(dataSearchJobs.stopRequestedAt),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return await set(getDataSearchJob$, args, signal);
  },
);
export const reconcileDataSearchJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const jobs = await db
      .select({ id: dataSearchJobs.id })
      .from(dataSearchJobs)
      .where(
        and(
          isNull(dataSearchJobs.creditsCharged),
          or(
            eq(dataSearchJobs.status, "pending"),
            eq(dataSearchJobs.status, "running"),
            eq(dataSearchJobs.status, "completed"),
            isNotNull(dataSearchJobs.upstreamRunId),
            isNotNull(dataSearchJobs.actualCostUsdMicros),
          ),
        ),
      )
      .orderBy(dataSearchJobs.updatedAt, dataSearchJobs.id)
      .limit(2);
    signal.throwIfAborted();
    for (const job of jobs) {
      // Rotate every attempted job, including an unconfirmed submission that
      // cannot advance yet, so the global bounded batch remains fair.
      await db
        .update(dataSearchJobs)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            eq(dataSearchJobs.id, job.id),
            isNull(dataSearchJobs.creditsCharged),
          ),
        );
      signal.throwIfAborted();
      await set(advanceDataSearchJob$, job.id, signal);
      signal.throwIfAborted();
    }
    return jobs.length;
  },
);
