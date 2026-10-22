import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  AMAZON_MARKETPLACES,
  parseAmazonProductTarget,
  type CommerceJob,
} from "@okouai/api-contracts/contracts/commerce";
import { commerceJobs } from "@okouai/db/schema/commerce-job";
import { command } from "ccstate";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { writeDb$ } from "../external/db";
import { joinAll } from "../utils";
import {
  commerceJobProviderConfigured,
  readCommerceTask,
  submitCommerceTask,
} from "./commerce-job-provider";
import { projectCommerceItems, type CommerceRequest } from "./commerce.service";
import { settleOrgUsage$ } from "./credit-usage-settlement.service";
import { completeProcessedOrgUsage$ } from "./credit-usage.service";
import { COMMERCE_RESOURCE as RESOURCE } from "./commerce-job-settlement";
import { checkCommerceCredits$ } from "./commerce-credit-admission.service";
import { creditPolicyRunId } from "./official-workflow-policy.service";

type Actor = AuthContext & { readonly orgId: string };
type Job = typeof commerceJobs.$inferSelect;
// Both priority-2 endpoints cost $0.003 per bounded task. Admission includes
// outstanding task liabilities; settlement uses task_post's actual cost, never
// a zero-cost GET. This preflight remains an estimate, not an atomic hard cap.
const PREFLIGHT_MICROS = 3000;
const SUBMISSION_UNCERTAIN = {
  code: "COMMERCE_SUBMISSION_UNCERTAIN",
  message:
    "DataForSEO may have accepted this task. Do not resubmit automatically; retain the job ID for investigation.",
} as const;

function publicJob(job: Job): CommerceJob {
  return {
    id: job.id,
    operation: job.operation,
    provider: "dataforseo",
    marketplace: job.marketplace,
    status: job.status,
    result:
      job.status === "completed" || job.status === "failed" ? job.result : null,
    error: job.error,
  };
}

function ownerWhere(auth: Pick<Actor, "orgId" | "userId">, id: string) {
  return and(
    eq(commerceJobs.id, id),
    eq(commerceJobs.orgId, auth.orgId),
    eq(commerceJobs.userId, auth.userId),
  );
}

function canonicalRequest(request: CommerceRequest): CommerceRequest {
  return request.operation === "search"
    ? {
        operation: "search",
        body: {
          query: request.body.query,
          marketplace: request.body.marketplace,
          limit: request.body.limit,
        },
      }
    : {
        operation: "inspect",
        body: {
          target: request.body.target,
          ...(request.body.marketplace
            ? { marketplace: request.body.marketplace }
            : {}),
        },
      };
}

function conflict() {
  return {
    status: 409 as const,
    body: {
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message:
          "This request ID belongs to different Commerce inputs. Use the original job ID to retrieve its status.",
      },
    },
  };
}

function replayJob(
  job: Job | undefined,
  auth: Actor,
  request: CommerceRequest,
) {
  return job &&
    job.orgId === auth.orgId &&
    job.userId === auth.userId &&
    isDeepStrictEqual(job.request, request)
    ? { status: 202 as const, body: publicJob(job) }
    : conflict();
}

export const createCommerceJob$ = command(
  async (
    { set },
    args: {
      readonly auth: Actor;
      readonly request: CommerceRequest;
      readonly requestId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const id = args.requestId ?? randomUUID();
    const request = canonicalRequest(args.request);
    const [existing] = await db
      .select()
      .from(commerceJobs)
      .where(eq(commerceJobs.id, id));
    signal.throwIfAborted();
    if (existing) {
      return replayJob(existing, args.auth, request);
    }
    if (!commerceJobProviderConfigured()) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "NOT_CONFIGURED",
            message: "Commerce DataForSEO provider is not configured",
          },
        },
      };
    }
    const product =
      request.operation === "inspect"
        ? parseAmazonProductTarget(request.body.target)
        : null;
    const marketplace =
      product?.marketplace ?? request.body.marketplace ?? "amazon.com";
    const creditError = await set(
      checkCommerceCredits$,
      {
        runId: creditPolicyRunId(args.auth),
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: { ...RESOURCE, quantity: PREFLIGHT_MICROS },
        label: "Commerce DataForSEO",
      },
      signal,
    );
    signal.throwIfAborted();
    if (creditError) {
      return creditError;
    }
    const [created] = await db
      .insert(commerceJobs)
      .values({
        id,
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId:
          args.auth.tokenType === "agent" || args.auth.tokenType === "sandbox"
            ? args.auth.runId
            : null,
        operation: request.operation,
        marketplace,
        request,
      })
      .onConflictDoNothing({ target: commerceJobs.id })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      const [winner] = await db
        .select()
        .from(commerceJobs)
        .where(eq(commerceJobs.id, id));
      signal.throwIfAborted();
      return replayJob(winner, args.auth, request);
    }
    const market = AMAZON_MARKETPLACES[marketplace];
    const submitted = await submitCommerceTask(
      request.operation,
      {
        se_domain: marketplace,
        location_code: market.locationCode,
        language_code: market.languageCode,
        priority: 2,
        tag: id,
        ...(request.operation === "search"
          ? {
              keyword: request.body.query,
              depth: request.body.limit,
              max_crawl_pages: 1,
            }
          : { asin: product?.asin }),
      },
      signal,
    );
    signal.throwIfAborted();
    const [saved] = await db
      .update(commerceJobs)
      .set({
        ...(submitted.kind === "submitted"
          ? {
              status: "running" as const,
              providerTaskId: submitted.id,
              providerCostUsd: submitted.cost,
            }
          : {
              status: "failed" as const,
              error:
                submitted.kind === "uncertain"
                  ? SUBMISSION_UNCERTAIN
                  : {
                      code: "COMMERCE_TASK_REJECTED",
                      message: "DataForSEO rejected the commerce task",
                    },
            }),
        updatedAt: nowDate(),
      })
      .where(and(eq(commerceJobs.id, id), eq(commerceJobs.status, "pending")))
      .returning();
    signal.throwIfAborted();
    if (!saved) {
      throw new Error("Commerce submission state was not saved");
    }
    return { status: 202 as const, body: publicJob(saved) };
  },
);

/** One provider read OR one settlement; no polling or sleeps inside an API call. */
export const advanceCommerceJob$ = command(
  async ({ set }, job: Job, signal: AbortSignal) => {
    if (job.status !== "running") {
      return;
    }
    const db = set(writeDb$);
    if (job.result) {
      const quantity = job.result.billingQuantity;
      if (quantity === 0) {
        // No usage/debit exists: the zero-cost receipt is one atomic update.
        await db
          .update(commerceJobs)
          .set({
            result: { ...job.result, creditsCharged: 0 },
            status: job.error ? "failed" : "completed",
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(commerceJobs.id, job.id),
              eq(commerceJobs.usageIdempotencyKey, job.usageIdempotencyKey),
              eq(commerceJobs.status, "running"),
              eq(commerceJobs.result, job.result),
            ),
          );
        signal.throwIfAborted();
        return;
      }
      // Publication, debit and durable terminal receipt share the existing
      // billing transaction. Never publish completion from this stale snapshot
      // or depend on a raw usage receipt surviving compaction.
      const result = await set(
        settleOrgUsage$,
        {
          orgId: job.orgId,
          commerceJobId: job.id,
        },
        signal,
      );
      if (result) {
        await set(
          completeProcessedOrgUsage$,
          { orgId: job.orgId, result },
          signal,
        );
      }
      return;
    }
    if (
      !job.providerTaskId ||
      job.providerCostUsd === null ||
      !commerceJobProviderConfigured()
    ) {
      return;
    }
    const outcome = await readCommerceTask(
      job.operation,
      job.providerTaskId,
      signal,
    );
    signal.throwIfAborted();
    if (outcome.kind === "pending") {
      // Rotate through the bounded recovery scan even when one provider task is
      // slow, rather than letting the oldest five tasks starve newer work.
      await db
        .update(commerceJobs)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            eq(commerceJobs.id, job.id),
            eq(commerceJobs.status, "running"),
            isNull(commerceJobs.result),
          ),
        );
      signal.throwIfAborted();
      return;
    }
    const cost = job.providerCostUsd + outcome.body.cost;
    const quantity = Math.ceil(cost * 1_000_000);
    if (!Number.isSafeInteger(quantity)) {
      throw new Error("Invalid Commerce provider cost");
    }
    await db
      .update(commerceJobs)
      .set({
        result: {
          operation: job.operation,
          provider: "dataforseo",
          marketplace: job.marketplace,
          billingCategory: RESOURCE.category,
          billingQuantity: quantity,
          providerCostUsd: cost,
          creditsCharged: null,
          result: {
            items:
              outcome.kind === "completed"
                ? projectCommerceItems(outcome.body, job.request)
                : [],
            source: outcome.body,
          },
        },
        error:
          outcome.kind === "failed"
            ? {
                code: "COMMERCE_TASK_ERROR",
                message: "DataForSEO commerce task failed",
              }
            : null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(commerceJobs.id, job.id),
          eq(commerceJobs.status, "running"),
          isNull(commerceJobs.result),
        ),
      );
    signal.throwIfAborted();
  },
);

export const getCommerceJob$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly id: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [job] = await db
      .select()
      .from(commerceJobs)
      .where(ownerWhere(args.auth, args.id));
    signal.throwIfAborted();
    if (!job) {
      return {
        status: 404 as const,
        body: {
          error: { code: "NOT_FOUND", message: "Commerce job not found" },
        },
      };
    }
    await set(advanceCommerceJob$, job, signal);
    signal.throwIfAborted();
    const [updated] = await db
      .select()
      .from(commerceJobs)
      .where(ownerWhere(args.auth, args.id));
    signal.throwIfAborted();
    if (!updated) {
      throw new Error("Commerce job disappeared during refresh");
    }
    return { status: 200 as const, body: publicJob(updated) };
  },
);

/** Bounded recovery independent of a CLI remaining connected. */
export const reconcileCommerceJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    // The serving API currently has a 300s platform maximum. A stale pending row
    // has no safe repeatable provider submission; surface uncertainty, not retry.
    const staleBefore = new Date(nowDate().getTime() - 5 * 60_000);
    const jobs = await db
      .select()
      .from(commerceJobs)
      .where(
        or(
          eq(commerceJobs.status, "running"),
          and(
            eq(commerceJobs.status, "pending"),
            lt(commerceJobs.createdAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(commerceJobs.updatedAt), asc(commerceJobs.id))
      .limit(5);
    signal.throwIfAborted();
    await joinAll(
      jobs.map(async (job) => {
        if (job.status === "pending") {
          await db
            .update(commerceJobs)
            .set({
              status: "failed",
              error: SUBMISSION_UNCERTAIN,
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(commerceJobs.id, job.id),
                eq(commerceJobs.status, "pending"),
              ),
            );
          signal.throwIfAborted();
          return;
        }
        await set(advanceCommerceJob$, job, signal);
      }),
    );
    signal.throwIfAborted();
    return jobs.length;
  },
);
