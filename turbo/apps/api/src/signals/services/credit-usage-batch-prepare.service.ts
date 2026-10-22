import { priceUsageEvents } from "./credit-usage-pricing";
import {
  commerceJobQuery,
  commerceJobsForUsageQuery,
  COMMERCE_RESOURCE,
  type CommerceSettlementJob,
} from "./commerce-job-settlement";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import {
  socialWhere,
  socialJobSelection,
  prepareSocialSettlement,
  type SocialSettlementClaim,
} from "./social-data-settlement-plan";
import {
  settlementPricingCondition,
  settlementPricingKeys,
  USAGE_SETTLEMENT_BATCH_SIZE,
  type PendingUsageSnapshot,
} from "./credit-usage-batch";

function settlementRunIds(
  events: readonly PendingUsageSnapshot[],
  socialRunId: string | null | undefined,
  commerce: readonly CommerceSettlementJob[],
) {
  return [
    ...new Set([
      ...events.flatMap(({ event }) => {
        return event.billingRunId ? [event.billingRunId] : [];
      }),
      ...(socialRunId ? [socialRunId] : []),
      ...commerce.flatMap((job) => {
        return job.runId ? [job.runId] : [];
      }),
    ]),
  ];
}

export const prepareUsageSettlementBatch$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly idempotencyKeys?: readonly string[];
      readonly social?: SocialSettlementClaim;
      readonly commerceJobId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [job] = args.social
      ? await db
          .select(socialJobSelection())
          .from(socialDataJobs)
          .where(
            and(eq(socialDataJobs.orgId, args.orgId), socialWhere(args.social)),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    const commerce = args.commerceJobId
      ? await db.select().from(commerceJobQuery(args.orgId, args.commerceJobId))
      : [];
    signal.throwIfAborted();
    const keys = args.commerceJobId
      ? commerce.map((row) => {
          return row.usageIdempotencyKey;
        })
      : args.social
        ? job
          ? [job.usageIdempotencyKey]
          : []
        : (args.idempotencyKeys ?? []);
    if (keys.length > USAGE_SETTLEMENT_BATCH_SIZE) {
      throw new Error("Usage settlement batch exceeds its event bound");
    }
    const snapshots = await db
      .select({
        event: usageEvent,
      })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, args.orgId),
          args.social ? undefined : eq(usageEvent.status, "pending"),
          inArray(usageEvent.idempotencyKey, keys),
        ),
      )
      .orderBy(asc(usageEvent.id))
      .limit(USAGE_SETTLEMENT_BATCH_SIZE);
    signal.throwIfAborted();
    const events = snapshots.filter(({ event }) => {
      return event.status === "pending";
    });
    const commerceKeys = events
      .filter(({ event }) => {
        return event.kind === "commerce";
      })
      .map(({ event }) => {
        return event.idempotencyKey;
      });
    if (!args.social && !args.commerceJobId && commerceKeys.length > 0) {
      commerce.push(
        ...(await db
          .select()
          .from(commerceJobsForUsageQuery(args.orgId, commerceKeys))),
      );
      signal.throwIfAborted();
    }
    const pricingKeys = [
      ...settlementPricingKeys(events),
      ...(args.commerceJobId ? [COMMERCE_RESOURCE] : []),
    ];
    const prices = await db
      .select()
      .from(usagePricing)
      .where(settlementPricingCondition(pricingKeys));
    signal.throwIfAborted();
    const runIds = settlementRunIds(events, job?.billingRunId, commerce);
    const freeRuns =
      runIds.length === 0
        ? []
        : await db
            .select({
              runId: billingRunAttribution.runId,
              userId: billingRunAttribution.userId,
            })
            .from(billingRunAttribution)
            .where(
              and(
                eq(billingRunAttribution.orgId, args.orgId),
                inArray(billingRunAttribution.runId, runIds),
                eq(
                  billingRunAttribution.creditChargePolicy,
                  "official_workflow_free",
                ),
              ),
            );
    signal.throwIfAborted();
    const freeOfficialRunOwners = new Map(
      freeRuns.map((run) => {
        return [run.runId, run.userId];
      }),
    );
    const records = events.map(({ event }) => {
      return {
        ...event,
        creditChargePolicy:
          event.billingRunId &&
          freeOfficialRunOwners.get(event.billingRunId) === event.userId
            ? ("official_workflow_free" as const)
            : ("standard" as const),
      };
    });
    const priced = priceUsageEvents(records, prices, args.orgId, false);
    const social = prepareSocialSettlement(job);
    return {
      events,
      freeOfficialRunOwners,
      social,
      commerce,
      prices,
      records,
      priced,
    };
  },
);
