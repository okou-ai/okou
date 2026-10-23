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
import {
  dataSearchJobQuery,
  prepareDataSearchSettlement,
} from "./data-search-settlement-plan";
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
  jobRunId: string | null | undefined,
  commerce: readonly CommerceSettlementJob[],
) {
  return [
    ...new Set([
      ...events.flatMap(({ event }) => {
        return event.billingRunId ? [event.billingRunId] : [];
      }),
      ...(jobRunId ? [jobRunId] : []),
      ...commerce.flatMap((job) => {
        return job.runId ? [job.runId] : [];
      }),
    ]),
  ];
}

interface PrepareUsageSettlementArgs {
  readonly orgId: string;
  readonly idempotencyKeys?: readonly string[];
  readonly social?: SocialSettlementClaim;
  readonly dataSearchJobId?: string;
  readonly commerceJobId?: string;
}

function settlementUsageKeys(
  args: PrepareUsageSettlementArgs,
  socialKey: string | undefined,
  dataSearchKey: string | undefined,
  commerce: readonly CommerceSettlementJob[],
) {
  if (args.commerceJobId) {
    return commerce.map((row) => {
      return row.usageIdempotencyKey;
    });
  }
  if (args.social) {
    return socialKey ? [socialKey] : [];
  }
  if (args.dataSearchJobId) {
    return dataSearchKey ? [dataSearchKey] : [];
  }
  return args.idempotencyKeys ?? [];
}

function settlementUsageRecords(
  events: readonly PendingUsageSnapshot[],
  freeOfficialRunOwners: ReadonlyMap<string, string>,
) {
  return events.map(({ event }) => {
    return {
      ...event,
      creditChargePolicy:
        event.billingRunId &&
        freeOfficialRunOwners.get(event.billingRunId) === event.userId
          ? ("official_workflow_free" as const)
          : ("standard" as const),
    };
  });
}

export const prepareUsageSettlementBatch$ = command(
  async ({ set }, args: PrepareUsageSettlementArgs, signal: AbortSignal) => {
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
    const [dataSearchJob] = args.dataSearchJobId
      ? await db
          .select()
          .from(dataSearchJobQuery(args.orgId, args.dataSearchJobId))
      : [];
    signal.throwIfAborted();
    const commerce = args.commerceJobId
      ? await db.select().from(commerceJobQuery(args.orgId, args.commerceJobId))
      : [];
    signal.throwIfAborted();
    const keys = settlementUsageKeys(
      args,
      job?.usageIdempotencyKey,
      dataSearchJob?.usageIdempotencyKey,
      commerce,
    );
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
          args.social || args.dataSearchJobId
            ? undefined
            : eq(usageEvent.status, "pending"),
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
    if (
      !args.social &&
      !args.dataSearchJobId &&
      !args.commerceJobId &&
      commerceKeys.length > 0
    ) {
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
    const runIds = settlementRunIds(
      events,
      job?.billingRunId ?? dataSearchJob?.billingRunId,
      commerce,
    );
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
    const records = settlementUsageRecords(events, freeOfficialRunOwners);
    const priced = priceUsageEvents(records, prices, args.orgId, false);
    const social = prepareSocialSettlement(job);
    const dataSearch = prepareDataSearchSettlement(dataSearchJob);
    return {
      events,
      freeOfficialRunOwners,
      social,
      dataSearch,
      commerce,
      prices,
      records,
      priced,
    };
  },
);
