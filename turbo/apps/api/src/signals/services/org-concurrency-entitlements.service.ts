import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { command, computed, type Computed } from "ccstate";
import { and, eq, gt, inArray, sql, sum } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

export const CONCURRENCY_SUBSCRIPTION_PURPOSE = "concurrency_subscription";
const CONCURRENCY_SUBSCRIPTION_ACTIVE_STATUSES = [
  "active",
  "trialing",
] as const;
export const CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES = [
  "past_due",
  "unpaid",
] as const;
const CONCURRENCY_PAYMENT_FAILURE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ActiveConcurrencySubscription {
  readonly id: string;
  readonly quantity: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly scheduledQuantity: number | null;
  readonly scheduledChangeAt: Date | null;
}

export function activeConcurrencyPriceId(): string | undefined {
  return env("OKOU_PRICE_CONCURRENCY")?.[0];
}

export function isConcurrencyPriceId(priceId: string): boolean {
  return env("OKOU_PRICE_CONCURRENCY")?.includes(priceId) ?? false;
}

export function cappedBaseConcurrencyLimit(tierLimit: number): number {
  const cap = env("CONCURRENT_RUN_LIMIT_CAP");
  if (cap === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (tierLimit === 0) {
    return 0;
  }
  return cap === undefined ? tierLimit : Math.min(tierLimit, cap);
}

export function totalConcurrencyLimit(args: {
  readonly baseLimit: number;
  readonly paidSlots: number;
}): number {
  if (!Number.isFinite(args.baseLimit)) {
    return Number.POSITIVE_INFINITY;
  }
  return args.baseLimit + args.paidSlots;
}

function activePaidThroughCutoff(at: Date): Date {
  return new Date(at.getTime() - CONCURRENCY_PAYMENT_FAILURE_GRACE_MS);
}

export function activeConcurrencySubscriptionPredicate(
  orgId: string,
  at: Date,
) {
  return and(
    eq(orgConcurrencySubscriptions.orgId, orgId),
    inArray(orgConcurrencySubscriptions.subscriptionStatus, [
      ...CONCURRENCY_SUBSCRIPTION_ACTIVE_STATUSES,
      ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
    ]),
    gt(
      orgConcurrencySubscriptions.currentPeriodEnd,
      activePaidThroughCutoff(at),
    ),
  );
}

const PAID_CONCURRENCY_SLOT_SELECTION = {
  slots:
    sql`COALESCE(${sum(orgConcurrencySubscriptions.slots)}, 0)::int`.mapWith(
      pgIntegerDecoder,
    ),
} as const;

export function activePaidConcurrencySlots(
  orgId: string,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const at = nowDate();
    const db = get(db$);
    const [row] = await db
      .select(PAID_CONCURRENCY_SLOT_SELECTION)
      .from(orgConcurrencySubscriptions)
      .where(activeConcurrencySubscriptionPredicate(orgId, at));
    return row?.slots ?? 0;
  });
}

export const loadActivePaidConcurrencySlots$ = command(
  async ({ get }, orgId: string, at: Date = nowDate()): Promise<number> => {
    const db = get(db$);
    const [row] = await db
      .select(PAID_CONCURRENCY_SLOT_SELECTION)
      .from(orgConcurrencySubscriptions)
      .where(activeConcurrencySubscriptionPredicate(orgId, at));
    return row?.slots ?? 0;
  },
);
