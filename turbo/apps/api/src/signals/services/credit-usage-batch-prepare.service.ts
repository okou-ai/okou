import { prepareUsageGrantPrefix$ } from "./usage-grant-prefix-prepare.service";
import { usageGrossByUser } from "./usage-grant-prefix";
import { priceUsageEvents } from "./credit-usage-pricing";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { command } from "ccstate";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
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
} from "./credit-usage-batch";

export const prepareUsageSettlementBatch$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly idempotencyKeys?: readonly string[];
      readonly social?: SocialSettlementClaim;
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
    const keys = args.social
      ? job
        ? [job.usageIdempotencyKey]
        : []
      : (args.idempotencyKeys ?? []);
    if (keys.length > USAGE_SETTLEMENT_BATCH_SIZE) {
      throw new Error("Usage settlement batch exceeds its event bound");
    }
    const events = await db
      .select({
        event: usageEvent,
        xmin: sql`${usageEvent}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, args.orgId),
          eq(usageEvent.status, "pending"),
          inArray(usageEvent.idempotencyKey, keys),
        ),
      )
      .orderBy(asc(usageEvent.id))
      .limit(USAGE_SETTLEMENT_BATCH_SIZE);
    signal.throwIfAborted();
    const pricingKeys = settlementPricingKeys(
      events,
      get(usagePricingResolution$),
    );
    const pricing = await db
      .select({
        price: usagePricing,
        xmin: sql`${usagePricing}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(usagePricing)
      .where(settlementPricingCondition(pricingKeys));
    signal.throwIfAborted();
    const prices = pricing.map(({ price }) => {
      return price;
    });
    const records = events.map(({ event }) => {
      return event;
    });
    const priced = priceUsageEvents(
      records,
      prices,
      args.orgId,
      get(usagePricingResolution$),
      false,
    );
    const social = prepareSocialSettlement(job);
    const grants = await set(
      prepareUsageGrantPrefix$,
      { orgId: args.orgId, grossByUser: usageGrossByUser(priced, social) },
      signal,
    );
    return {
      events,
      social,
      pricing,
      pricingKeys,
      prices,
      records,
      priced,
      grants,
    };
  },
);
