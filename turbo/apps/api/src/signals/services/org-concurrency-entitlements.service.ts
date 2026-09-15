import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { and, asc, count, eq, gt, inArray, sql, sum } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { sandboxCapacityPredicate } from "./pi-inference-lifecycle.service";

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

type ReadDb = Pick<Db, "select">;

export interface ActiveConcurrencySubscription {
  readonly id: string;
  readonly quantity: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly scheduledQuantity: number | null;
  readonly scheduledChangeAt: Date | null;
}

interface OrgConcurrencyState {
  readonly baseConcurrencyLimit: number;
  readonly paidSlots: number;
  readonly activeRunCount: number;
}

function dbTimestamp(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
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

function activeConcurrencySubscriptionPredicate(orgId: string, at: Date) {
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

export async function activePaidConcurrencySlots(
  db: ReadDb,
  orgId: string,
  at: Date = nowDate(),
): Promise<number> {
  const [row] = await db
    .select({
      slots:
        sql`COALESCE(${sum(orgConcurrencySubscriptions.slots)}, 0)::int`.mapWith(
          pgIntegerDecoder,
        ),
    })
    .from(orgConcurrencySubscriptions)
    .where(activeConcurrencySubscriptionPredicate(orgId, at));

  return row?.slots ?? 0;
}

export async function loadOrgConcurrencyState(
  db: ReadDb,
  args: {
    readonly orgId: string;
    readonly at: Date;
    readonly activePendingAfter: Date;
  },
): Promise<OrgConcurrencyState> {
  const paidSlotTotals = db
    .select({
      slots: sql`COALESCE(${sum(orgConcurrencySubscriptions.slots)}, 0)::int`
        .mapWith(pgIntegerDecoder)
        .as("slots"),
    })
    .from(orgConcurrencySubscriptions)
    .where(activeConcurrencySubscriptionPredicate(args.orgId, args.at))
    .as("paid_concurrency_slot_totals");
  const activeRunTotals = db
    .select({
      count: count().as("active_run_count"),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, args.orgId),
        sandboxCapacityPredicate(db, args.orgId, args.activePendingAfter),
      ),
    )
    .as("active_concurrency_run_totals");

  const [row] = await db
    .select({
      entitlementOrgId: orgPlanEntitlements.orgId,
      metadataOrgId: orgMetadata.orgId,
      baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
      paidSlots: paidSlotTotals.slots,
      activeRunCount: activeRunTotals.count,
    })
    .from(paidSlotTotals)
    .crossJoin(activeRunTotals)
    .leftJoin(orgPlanEntitlements, eq(orgPlanEntitlements.orgId, args.orgId))
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, args.orgId));
  if (!row) {
    throw new Error("Concurrency state aggregate returned no row");
  }
  if (row.entitlementOrgId === null && row.metadataOrgId !== null) {
    throw new Error(`Missing org plan entitlement for ${args.orgId}`);
  }

  return {
    baseConcurrencyLimit: row.baseConcurrencyLimit ?? 0,
    paidSlots: row.paidSlots,
    activeRunCount: row.activeRunCount,
  };
}

export async function activeConcurrencySubscriptions(
  db: ReadDb,
  orgId: string,
  at: Date = nowDate(),
): Promise<readonly ActiveConcurrencySubscription[]> {
  const rows = await db
    .select({
      id: orgConcurrencySubscriptions.stripeSubscriptionId,
      quantity: orgConcurrencySubscriptions.slots,
      currentPeriodEnd: orgConcurrencySubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
      scheduledQuantity: orgConcurrencySubscriptions.scheduledSlots,
      scheduledChangeAt: orgConcurrencySubscriptions.scheduledChangeAt,
    })
    .from(orgConcurrencySubscriptions)
    .where(activeConcurrencySubscriptionPredicate(orgId, at))
    .orderBy(
      asc(orgConcurrencySubscriptions.createdAt),
      asc(orgConcurrencySubscriptions.stripeSubscriptionId),
    );

  return rows
    .map((row) => {
      return {
        id: row.id,
        quantity: Number(row.quantity),
        currentPeriodEnd: dbTimestamp(row.currentPeriodEnd),
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        scheduledQuantity: row.scheduledQuantity,
        scheduledChangeAt: dbTimestamp(row.scheduledChangeAt),
      };
    })
    .filter((row) => {
      return row.quantity > 0;
    });
}
