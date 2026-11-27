import { platformPaidCreditPolicies } from "./platform-paid-run.service";
import { priceUsageEvents } from "./credit-usage-pricing";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/runtime/usage-event";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
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
  platformRuns: ReadonlyMap<
    string,
    Pick<
      typeof billingRunAttribution.$inferSelect,
      "userId" | "creditChargePolicy"
    >
  >,
) {
  return events.map(({ event }) => {
    const payer = event.billingRunId
      ? platformRuns.get(event.billingRunId)
      : undefined;
    return {
      ...event,
      creditChargePolicy:
        payer && payer.userId === event.userId
          ? payer.creditChargePolicy
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
              creditChargePolicy: billingRunAttribution.creditChargePolicy,
            })
            .from(billingRunAttribution)
            .where(
              and(
                eq(billingRunAttribution.orgId, args.orgId),
                inArray(billingRunAttribution.runId, runIds),
                inArray(billingRunAttribution.creditChargePolicy, [
                  ...platformPaidCreditPolicies,
                ]),
              ),
            );
    signal.throwIfAborted();
    const platformRuns = new Map(
      freeRuns.map((run) => {
        return [run.runId, run];
      }),
    );
    const records = settlementUsageRecords(events, platformRuns);
    const priced = priceUsageEvents(records, prices, args.orgId, false);
    return { events, prices, records, priced };
  },
);
