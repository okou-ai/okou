import { priceUsageEvents } from "./credit-usage-pricing";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import {
  settlementPricingCondition,
  settlementPricingKeys,
  USAGE_SETTLEMENT_BATCH_SIZE,
  type PendingUsageSnapshot,
} from "./credit-usage-batch";

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
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly idempotencyKeys: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (args.idempotencyKeys.length > USAGE_SETTLEMENT_BATCH_SIZE) {
      throw new Error("Usage settlement batch exceeds its event bound");
    }
    const events = await db
      .select({ event: usageEvent })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, args.orgId),
          eq(usageEvent.status, "pending"),
          inArray(usageEvent.idempotencyKey, [...args.idempotencyKeys]),
        ),
      )
      .orderBy(asc(usageEvent.id))
      .limit(USAGE_SETTLEMENT_BATCH_SIZE);
    signal.throwIfAborted();
    const prices = await db
      .select()
      .from(usagePricing)
      .where(settlementPricingCondition(settlementPricingKeys(events)));
    signal.throwIfAborted();
    const runIds = [
      ...new Set(
        events.flatMap(({ event }) => {
          return event.billingRunId ? [event.billingRunId] : [];
        }),
      ),
    ];
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
    return { events, prices, records, priced };
  },
);
