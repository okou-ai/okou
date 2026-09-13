import { computed, type Computed } from "ccstate";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import {
  and,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  sum,
} from "drizzle-orm";

import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";
import {
  activeConcurrencySubscriptions,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
  type ActiveConcurrencySubscription,
} from "./org-concurrency-entitlements.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { canRestorePlanSubscription } from "./billing-restore.service";

const TIER_MONTHLY_CREDITS = Object.freeze<Record<PlanCreditTier, number>>({
  pro: 20_000,
  team: 120_000,
});

type CreditBreakdownCategory = "plan" | "free" | "promotional" | "payAsYouGo";
type PlanCreditTier = "pro" | "team";
type ScheduledBillingTargetTier =
  | "limited-free-1"
  | "pro-suspend"
  | "pro"
  | "team";
type UsageAllowanceWindowKind = "short" | "weekly";

const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";
const ACTIVE_USAGE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
  "past_due",
] as const;
const USAGE_ALLOWANCE_WINDOW_KINDS = ["short", "weekly"] as const;

interface ScheduledBillingChange {
  type: "cancel" | "downgrade";
  targetTier: ScheduledBillingTargetTier | null;
  effectiveDate: string | null;
}

interface CreditBreakdownSegment {
  category: CreditBreakdownCategory;
  label: string;
  credits: number;
  tier?: PlanCreditTier;
}

interface ActiveCreditRecord {
  id: string;
  source: string;
  amount: number;
  remaining: number;
  expiresAt: Date;
  createdAt: Date;
}

interface ActiveUsageAllowanceEntitlement {
  shortWindowSeconds: number;
  shortWindowUnits: number;
  weeklyWindowSeconds: number;
  weeklyWindowUnits: number;
}

interface ActiveUsageAllowanceWindow {
  kind: UsageAllowanceWindowKind;
  startsAt: Date;
  expiresAt: Date;
  unitLimit: number;
  consumedUnits: number;
}

interface UsageAllowanceWindowStatus {
  kind: UsageAllowanceWindowKind;
  windowSeconds: number;
  unitLimit: number;
  consumedUnits: number;
  remainingUnits: number;
  startsAt: string | null;
  expiresAt: string | null;
}

interface UsageAllowanceStatus {
  windows: UsageAllowanceWindowStatus[];
}

interface ActiveUsageAllowanceStatus {
  status: UsageAllowanceStatus;
  stripeSubscriptionId: string | null;
}

interface BillingOrgRow {
  tier: string;
  credits: number;
  onboardingPaymentPending: boolean;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingSubscriptionScheduleId: string | null;
  pendingSubscriptionTargetTier: string | null;
  pendingSubscriptionChangeAt: Date | null;
  stripeSubscriptionId: string | null;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: number | null;
  autoRechargeAmount: number | null;
}

interface BillingStatusResponse {
  tier: string;
  status: OrgPlanCapabilities["status"];
  canBuyConcurrency: boolean;
  concurrencyPurchaseReviewAvailable: boolean;
  canBuyCredits: boolean;
  showUsagePack: boolean;
  // Wire compatibility for outgoing Apps only; derived from status (#32575).
  memberInvitationAllowed: boolean;
  autoRechargeAllowed: boolean;
  supportByok: boolean;
  restrictedBuiltInModels: boolean;
  // Retired brand alias of restrictedBuiltInModels, carrying an identical
  // value from the same source. Surface: old web/app -> API. Apps older than
  // this release read only this name, and because the contract marks both
  // optional they would silently fall back to their hardcoded legacy tier
  // table instead of failing. Remove once the replacement app is live and the
  // client-version floor excludes those builds: #33658 step 2.
  restrictedVm0Models: boolean;
  videoGenerationAllowed: boolean;
  workflowWebhookAutomationAllowed: boolean;
  credits: number;
  onboardingPaymentPending: boolean;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: ScheduledBillingChange | null;
  canRestorePlan: boolean;
  hasSubscription: boolean;
  autoRecharge: {
    enabled: boolean;
    threshold: number | null;
    amount: number | null;
  };
  creditExpiry: {
    expiringNextCycle: number;
    nextExpiryDate: string | null;
  };
  creditBreakdown: CreditBreakdownSegment[];
  creditGrants: {
    id: string;
    source: string;
    label: string;
    amount: number;
    remaining: number;
    createdAt: string;
    expiresAt: string;
  }[];
  concurrencySubscriptions: {
    id: string;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    canReduce?: boolean;
    canChangeInApp?: boolean;
    scheduledQuantity?: number | null;
    scheduledChangeAt?: string | null;
  }[];
  usageAllowance: UsageAllowanceStatus | null;
  concurrencyLimit: number;
}

const DEFAULT_BILLING_ORG = Object.freeze<BillingOrgRow>({
  tier: "pro-suspend",
  credits: 0,
  onboardingPaymentPending: false,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pendingSubscriptionScheduleId: null,
  pendingSubscriptionTargetTier: null,
  pendingSubscriptionChangeAt: null,
  stripeSubscriptionId: null,
  autoRechargeEnabled: false,
  autoRechargeThreshold: null,
  autoRechargeAmount: null,
});

function planTierFromAmount(amount: number): PlanCreditTier | null {
  if (amount === TIER_MONTHLY_CREDITS.team) {
    return "team";
  }
  if (amount === TIER_MONTHLY_CREDITS.pro) {
    return "pro";
  }
  return null;
}

function isPayAsYouGoCreditSource(source: string): boolean {
  return source === "auto_recharge" || source === "credit_purchase";
}

function labelForCreditRecord(
  record: Pick<ActiveCreditRecord, "source" | "amount">,
): string {
  if (record.source === "subscription_renewal") {
    const planTier = planTierFromAmount(record.amount);
    if (planTier === "team") {
      return "Team plan";
    }
    if (planTier === "pro") {
      return "Pro plan";
    }
    return "Plan credits";
  }
  if (record.source === "starter_grant" || record.source === "onboarding") {
    return "Free plan";
  }
  if (record.source === "one_time_purchase") {
    return "Promotional";
  }
  if (isPayAsYouGoCreditSource(record.source)) {
    return "Pay as you go";
  }
  return "Credits";
}

function buildCreditBreakdown(args: {
  orgId: string;
  tier: string;
  displayedCredits: number;
  records: readonly ActiveCreditRecord[];
}): CreditBreakdownSegment[] {
  const { tier, displayedCredits, records } = args;

  const segmentKey = (
    category: CreditBreakdownCategory,
    tierKey?: string,
  ): string => {
    return tierKey ? `${category}:${tierKey}` : category;
  };

  const byKey = new Map<string, CreditBreakdownSegment>();
  const addSegment = (segment: CreditBreakdownSegment): void => {
    const key = segmentKey(segment.category, segment.tier);
    const existing = byKey.get(key);
    if (existing) {
      existing.credits += segment.credits;
    } else {
      byKey.set(key, { ...segment });
    }
  };

  let trackedTotal = 0;
  for (const record of records) {
    trackedTotal += record.remaining;
    if (record.source === "subscription_renewal") {
      const planTier = planTierFromAmount(record.amount);
      if (!planTier) {
        trackedTotal -= record.remaining;
        continue;
      }
      addSegment({
        category: "plan",
        label: planTier === "team" ? "Team plan" : "Pro plan",
        credits: record.remaining,
        tier: planTier,
      });
    } else if (
      record.source === "starter_grant" ||
      record.source === "onboarding"
    ) {
      addSegment({
        category: "free",
        label: "Free plan",
        credits: record.remaining,
      });
    } else if (record.source === "one_time_purchase") {
      addSegment({
        category: "promotional",
        label: "Promotional",
        credits: record.remaining,
      });
    } else if (isPayAsYouGoCreditSource(record.source)) {
      addSegment({
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: record.remaining,
      });
    }
  }

  const untracked = Math.max(displayedCredits - trackedTotal, 0);
  if (untracked > 0) {
    const isFreeTier = tier === "free" || tier === "limited-free-1";
    addSegment({
      category: isFreeTier ? "free" : "payAsYouGo",
      label: isFreeTier ? "Free plan" : "Pay as you go",
      credits: untracked,
    });
  }

  const categoryOrder: CreditBreakdownCategory[] = [
    "plan",
    "free",
    "promotional",
    "payAsYouGo",
  ];
  const planTierOrder: Record<PlanCreditTier, number> = {
    pro: 0,
    team: 1,
  };
  const segments = Array.from(byKey.values());
  segments.sort((a, b) => {
    const categoryDelta =
      categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    if (a.category === "plan" && b.category === "plan") {
      if (!a.tier || !b.tier) {
        throw new Error("Plan credit breakdown segment is missing a tier");
      }
      return planTierOrder[a.tier] - planTierOrder[b.tier];
    }
    return 0;
  });
  return segments;
}

function creditGrants(records: readonly ActiveCreditRecord[]) {
  return records.map((record) => {
    return {
      id: record.id,
      source: record.source,
      label: labelForCreditRecord(record),
      amount: record.amount,
      remaining: record.remaining,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  });
}

function creditExpiry(records: readonly ActiveCreditRecord[]): {
  expiringNextCycle: number;
  nextExpiryDate: string | null;
} {
  const expiryRecords = [...records].sort((a, b) => {
    return a.expiresAt.getTime() - b.expiresAt.getTime();
  });
  const firstExpiry = expiryRecords[0]?.expiresAt ?? null;
  if (!firstExpiry) {
    return { expiringNextCycle: 0, nextExpiryDate: null };
  }

  const expiringNextCycle = expiryRecords
    .filter((record) => {
      return record.expiresAt.getTime() === firstExpiry.getTime();
    })
    .reduce((sum, record) => {
      return sum + record.remaining;
    }, 0);

  return {
    expiringNextCycle,
    nextExpiryDate: firstExpiry.toISOString(),
  };
}

function usageAllowanceWindowSeconds(
  entitlement: ActiveUsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowSeconds
    : entitlement.weeklyWindowSeconds;
}

function usageAllowanceWindowUnitLimit(
  entitlement: ActiveUsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowUnits
    : entitlement.weeklyWindowUnits;
}

function isUsageAllowanceWindowKind(
  value: string,
): value is UsageAllowanceWindowKind {
  return value === "short" || value === "weekly";
}

function remainingAllowanceUnits(args: {
  unitLimit: number;
  consumedUnits: number;
}): number {
  return Math.max(args.unitLimit - args.consumedUnits, 0);
}

function usageAllowanceWindowStatus(args: {
  entitlement: ActiveUsageAllowanceEntitlement;
  kind: UsageAllowanceWindowKind;
  activeWindow: ActiveUsageAllowanceWindow | undefined;
}): UsageAllowanceWindowStatus {
  const unitLimit =
    args.activeWindow?.unitLimit ??
    usageAllowanceWindowUnitLimit(args.entitlement, args.kind);
  const consumedUnits = args.activeWindow?.consumedUnits ?? 0;

  return {
    kind: args.kind,
    windowSeconds: usageAllowanceWindowSeconds(args.entitlement, args.kind),
    unitLimit,
    consumedUnits,
    remainingUnits: remainingAllowanceUnits({ unitLimit, consumedUnits }),
    startsAt: args.activeWindow?.startsAt.toISOString() ?? null,
    expiresAt: args.activeWindow?.expiresAt.toISOString() ?? null,
  };
}

async function activeUsageAllowanceStatus(
  db: ReadonlyDb,
  orgId: string,
  currentTime: Date,
): Promise<ActiveUsageAllowanceStatus | null> {
  const [entitlement] = await db
    .select({
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_USAGE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, currentTime),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, currentTime),
        ),
      ),
    )
    .limit(1);
  if (!entitlement) {
    return null;
  }

  const activeWindows = await db
    .select({
      kind: orgUsageAllowanceWindows.kind,
      startsAt: orgUsageAllowanceWindows.startsAt,
      expiresAt: orgUsageAllowanceWindows.expiresAt,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, orgId),
        inArray(orgUsageAllowanceWindows.kind, [
          ...USAGE_ALLOWANCE_WINDOW_KINDS,
        ]),
        gte(orgUsageAllowanceWindows.startsAt, entitlement.effectiveAt),
        lte(orgUsageAllowanceWindows.startsAt, currentTime),
        gt(orgUsageAllowanceWindows.expiresAt, currentTime),
      ),
    )
    .orderBy(desc(orgUsageAllowanceWindows.startsAt));

  const windowByKind = new Map<
    UsageAllowanceWindowKind,
    ActiveUsageAllowanceWindow
  >();
  for (const window of activeWindows) {
    if (
      isUsageAllowanceWindowKind(window.kind) &&
      !windowByKind.has(window.kind)
    ) {
      windowByKind.set(window.kind, {
        kind: window.kind,
        startsAt: window.startsAt,
        expiresAt: window.expiresAt,
        unitLimit: window.unitLimit,
        consumedUnits: window.consumedUnits,
      });
    }
  }

  return {
    status: {
      windows: USAGE_ALLOWANCE_WINDOW_KINDS.map((kind) => {
        return usageAllowanceWindowStatus({
          entitlement,
          kind,
          activeWindow: windowByKind.get(kind),
        });
      }),
    },
    stripeSubscriptionId: entitlement.stripeSubscriptionId,
  };
}

function scheduledTargetTier(
  value: string | null,
): ScheduledBillingTargetTier | null {
  if (
    value === "limited-free-1" ||
    value === "pro-suspend" ||
    value === "pro" ||
    value === "team"
  ) {
    return value;
  }
  return null;
}

function scheduledBillingChange(
  org: BillingOrgRow,
): ScheduledBillingChange | null {
  if (org.cancelAtPeriodEnd) {
    return {
      type: "cancel",
      targetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
      effectiveDate:
        org.pendingSubscriptionChangeAt?.toISOString() ??
        org.currentPeriodEnd?.toISOString() ??
        null,
    };
  }

  if (!org.pendingSubscriptionScheduleId) {
    return null;
  }

  const targetTier = scheduledTargetTier(org.pendingSubscriptionTargetTier);
  if (!targetTier) {
    return null;
  }

  return {
    type: "downgrade",
    targetTier,
    effectiveDate:
      org.pendingSubscriptionChangeAt?.toISOString() ??
      org.currentPeriodEnd?.toISOString() ??
      null,
  };
}

function hasManageablePlanSubscription(org: BillingOrgRow): boolean {
  return (
    org.stripeSubscriptionId !== null &&
    org.subscriptionStatus !== "canceled" &&
    org.subscriptionStatus !== "incomplete_expired"
  );
}

function billingStatusResponse(args: {
  orgId: string;
  org: BillingOrgRow | undefined;
  canBuyConcurrency: boolean;
  canBuyCredits: boolean;
  showUsagePack: boolean;
  status: OrgPlanCapabilities["status"];
  autoRechargeAllowed: boolean;
  supportByok: boolean;
  restrictedBuiltInModels: boolean;
  videoGenerationAllowed: boolean;
  workflowWebhookAutomationAllowed: boolean;
  unsettledExpired: number;
  activeRecords: readonly ActiveCreditRecord[];
  concurrencySubscriptions: readonly ActiveConcurrencySubscription[];
  usageAllowance: ActiveUsageAllowanceStatus | null;
  baseConcurrencyLimit: number;
}): BillingStatusResponse {
  const org = args.org ?? DEFAULT_BILLING_ORG;
  const displayedCredits = org.credits - args.unsettledExpired;
  const paidConcurrencySlots = args.concurrencySubscriptions.reduce(
    (total, subscription) => {
      return total + subscription.quantity;
    },
    0,
  );
  const cappedBaseLimit = cappedBaseConcurrencyLimit(args.baseConcurrencyLimit);
  const displayedBaseLimit = Number.isFinite(cappedBaseLimit)
    ? cappedBaseLimit
    : args.baseConcurrencyLimit;

  return {
    tier: org.tier,
    canBuyConcurrency: args.canBuyConcurrency,
    concurrencyPurchaseReviewAvailable: true,
    canBuyCredits: args.canBuyCredits,
    showUsagePack: args.showUsagePack,
    status: args.status,
    memberInvitationAllowed: args.status === "active",
    autoRechargeAllowed: args.autoRechargeAllowed,
    supportByok: args.supportByok,
    restrictedBuiltInModels: args.restrictedBuiltInModels,
    restrictedVm0Models: args.restrictedBuiltInModels,
    videoGenerationAllowed: args.videoGenerationAllowed,
    workflowWebhookAutomationAllowed: args.workflowWebhookAutomationAllowed,
    credits: displayedCredits,
    onboardingPaymentPending: org.onboardingPaymentPending,
    subscriptionStatus: org.subscriptionStatus,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    scheduledChange: scheduledBillingChange(org),
    canRestorePlan: canRestorePlanSubscription(org),
    hasSubscription:
      hasManageablePlanSubscription(org) ||
      args.concurrencySubscriptions.length > 0 ||
      (args.usageAllowance !== null &&
        args.usageAllowance.stripeSubscriptionId !== null),
    autoRecharge: {
      enabled: org.autoRechargeEnabled,
      threshold: org.autoRechargeThreshold,
      amount: org.autoRechargeAmount,
    },
    creditExpiry: creditExpiry(args.activeRecords),
    creditBreakdown: buildCreditBreakdown({
      orgId: args.orgId,
      tier: org.tier,
      displayedCredits,
      records: args.activeRecords,
    }),
    creditGrants: creditGrants(args.activeRecords),
    concurrencyLimit: totalConcurrencyLimit({
      baseLimit: displayedBaseLimit,
      paidSlots: paidConcurrencySlots,
    }),
    concurrencySubscriptions: args.concurrencySubscriptions.map(
      (subscription) => {
        return {
          id: subscription.id,
          quantity: subscription.quantity,
          currentPeriodEnd:
            subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          ...(subscription.scheduledQuantity !== null
            ? {
                scheduledQuantity: subscription.scheduledQuantity,
                scheduledChangeAt:
                  subscription.scheduledChangeAt?.toISOString() ?? null,
              }
            : {}),
          ...(subscription.quantity > 1 && !subscription.cancelAtPeriodEnd
            ? { canReduce: true as const }
            : {}),
          ...(!subscription.cancelAtPeriodEnd
            ? { canChangeInApp: true as const }
            : {}),
        };
      },
    ),
    usageAllowance: args.usageAllowance?.status ?? null,
  };
}

function billingPlanStatus(
  capabilities: OrgPlanCapabilities | null,
): OrgPlanCapabilities["status"] {
  return capabilities?.status ?? "suspended";
}

export function orgBillingStatus(
  orgId: string,
): Computed<Promise<BillingStatusResponse>> {
  return computed(async (get): Promise<BillingStatusResponse> => {
    const db = get(db$);
    const currentTime = nowDate();
    const [
      org,
      unsettledExpiredRow,
      activeRecords,
      concurrencySubscriptions,
      usageAllowance,
      capabilities,
    ] = await Promise.all([
      db
        .select({
          tier: orgMetadata.tier,
          credits: orgMetadata.credits,
          onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
          subscriptionStatus: orgMetadata.subscriptionStatus,
          currentPeriodEnd: orgMetadata.currentPeriodEnd,
          cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
          pendingSubscriptionScheduleId:
            orgMetadata.pendingSubscriptionScheduleId,
          pendingSubscriptionTargetTier:
            orgMetadata.pendingSubscriptionTargetTier,
          pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
          stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
          autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
          autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
          autoRechargeAmount: orgMetadata.autoRechargeAmount,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1),
      db
        .select({
          total:
            sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::int`.mapWith(
              pgIntegerDecoder,
            ),
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            lte(creditExpiresRecord.expiresAt, currentTime),
            gt(creditExpiresRecord.remaining, 0),
          ),
        ),
      db
        .select({
          id: creditExpiresRecord.id,
          source: creditExpiresRecord.source,
          amount: creditExpiresRecord.amount,
          remaining: creditExpiresRecord.remaining,
          expiresAt: creditExpiresRecord.expiresAt,
          createdAt: creditExpiresRecord.createdAt,
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            gt(creditExpiresRecord.remaining, 0),
            gt(creditExpiresRecord.expiresAt, currentTime),
          ),
        )
        .orderBy(desc(creditExpiresRecord.createdAt)),
      activeConcurrencySubscriptions(db, orgId, currentTime),
      activeUsageAllowanceStatus(db, orgId, currentTime),
      loadOrgPlanCapabilities(db, orgId),
    ]);

    return billingStatusResponse({
      orgId,
      org: org[0],
      canBuyConcurrency: capabilities?.canBuyConcurrency ?? false,
      canBuyCredits: capabilities?.canBuyCredits ?? false,
      showUsagePack: capabilities?.showUsagePack === true,
      status: billingPlanStatus(capabilities),
      autoRechargeAllowed: capabilities?.autoRechargeAllowed ?? false,
      supportByok: capabilities?.supportByok ?? false,
      restrictedBuiltInModels: capabilities?.restrictedBuiltInModels ?? false,
      videoGenerationAllowed: capabilities?.videoGenerationAllowed ?? false,
      workflowWebhookAutomationAllowed:
        capabilities?.workflowWebhookAutomationAllowed ?? false,
      unsettledExpired: unsettledExpiredRow[0]?.total ?? 0,
      activeRecords,
      concurrencySubscriptions,
      usageAllowance,
      baseConcurrencyLimit: capabilities?.baseConcurrencyLimit ?? 0,
    });
  });
}
