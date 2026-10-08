import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

import { getStripeClient } from "../external/stripe-client";
import {
  allowanceAvailabilityQuery,
  allowanceWindowRemainingUnits,
} from "./usage-allowance-availability-plan";

import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
} from "./usage-allowance-policy";
type UsageAllowanceWindowKind = "short" | "weekly";

const L = logger("UsageAllowance");
const TERMINAL_ALLOWANCE_STATUSES = ["canceled", "incomplete_expired"] as const;

interface UsageAllowanceSubscriptionInput {
  readonly id: string;
  readonly status: string;
  readonly cancel_at?: number | null;
  readonly items: {
    readonly data: readonly {
      readonly current_period_end?: number | null;
    }[];
  };
}

interface UsageAllowanceAvailability {
  readonly remainingUnits: number;
  readonly shortRemainingUnits: number;
  readonly weeklyRemainingUnits: number;
}

export function remainingUnits(window: {
  readonly unitLimit: number;
  readonly consumedUnits: number;
}): number {
  return Math.max(window.unitLimit - window.consumedUnits, 0);
}

function subscriptionPeriodEnd(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function subscriptionCancelAt(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function subscriptionScheduledEnd(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  const periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAt = subscriptionCancelAt(subscription);
  if (!periodEnd) {
    return null;
  }
  return cancelAt && cancelAt < periodEnd ? cancelAt : periodEnd;
}

function subscriptionCanBackUsageAllowance(
  subscription: UsageAllowanceSubscriptionInput,
): boolean {
  return ACTIVE_ALLOWANCE_STATUSES.includes(
    subscription.status as (typeof ACTIVE_ALLOWANCE_STATUSES)[number],
  );
}

function subscriptionIsTerminalAllowance(
  subscription: UsageAllowanceSubscriptionInput,
): boolean {
  return TERMINAL_ALLOWANCE_STATUSES.includes(
    subscription.status as (typeof TERMINAL_ALLOWANCE_STATUSES)[number],
  );
}

export interface PreparedUsageAllowanceRefresh {
  readonly entitlementId: string;
  readonly snapshot: string;
  readonly subscription: UsageAllowanceSubscriptionInput;
}
function allowanceRefreshQuery(orgId: string) {
  return new QueryBuilder()
    .select({
      id: orgUsageAllowanceEntitlements.id,
      status: orgUsageAllowanceEntitlements.status,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      snapshot: sql`${orgUsageAllowanceEntitlements}::text`
        .mapWith(pgTextDecoder)
        .as("snapshot"),
    })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, nowDate()),
      ),
    )
    .limit(1)
    .as("allowance_refresh");
}
export async function prepareAllowanceRefresh(
  row:
    | {
        readonly id: string;
        readonly status: string;
        readonly expiresAt: Date | null;
        readonly stripeSubscriptionId: string | null;
        readonly snapshot: string;
      }
    | undefined,
): Promise<PreparedUsageAllowanceRefresh | undefined> {
  if (
    !row?.stripeSubscriptionId ||
    !row.expiresAt ||
    row.expiresAt > activeAllowanceCutoff(row.status, nowDate())
  ) {
    return undefined;
  }
  const subscription = (await getStripeClient().subscriptions.retrieve(
    row.stripeSubscriptionId,
  )) as UsageAllowanceSubscriptionInput;
  return { entitlementId: row.id, snapshot: row.snapshot, subscription };
}
function pendingAllowanceRefreshQuery(
  orgId: string,
  idempotencyKeys?: readonly string[],
) {
  const queryBuilder = new QueryBuilder();
  const anchor = sql`COALESCE(${usageEvent.billingAnchorAt}, ${agentRuns.createdAt}, ${usageEvent.createdAt})`;
  const issuedWindow = (kind: UsageAllowanceWindowKind) => {
    return queryBuilder
      .select({ id: orgUsageAllowanceWindows.id })
      .from(orgUsageAllowanceWindows)
      .where(
        and(
          eq(orgUsageAllowanceWindows.orgId, orgId),
          eq(orgUsageAllowanceWindows.kind, kind),
          lte(orgUsageAllowanceWindows.startsAt, anchor),
          gt(orgUsageAllowanceWindows.expiresAt, anchor),
        ),
      );
  };
  return queryBuilder
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .leftJoin(
      agentRuns,
      and(eq(agentRuns.id, usageEvent.runId), eq(agentRuns.orgId, orgId)),
    )
    .where(
      and(
        eq(usageEvent.orgId, orgId),
        eq(usageEvent.status, "pending"),
        idempotencyKeys
          ? inArray(usageEvent.idempotencyKey, [...idempotencyKeys])
          : undefined,
        notExists(
          queryBuilder
            .select({ id: usageAllowanceAllocations.usageEventId })
            .from(usageAllowanceAllocations)
            .where(eq(usageAllowanceAllocations.usageEventId, usageEvent.id)),
        ),
        or(notExists(issuedWindow("short")), notExists(issuedWindow("weekly"))),
      ),
    )
    .limit(1)
    .as("pending_allowance_refresh");
}

/** Stripe preparation owns no financial row, advisory lock, or SQL transaction. */
export const prepareUsageAllowanceRefresh$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly requirePendingUsage?: boolean;
      readonly idempotencyKeys?: readonly string[];
    },
    signal?: AbortSignal,
  ) => {
    const database = get(db$);
    if (args.requirePendingUsage) {
      const [pending] = await database
        .select()
        .from(pendingAllowanceRefreshQuery(args.orgId, args.idempotencyKeys));
      signal?.throwIfAborted();
      if (!pending) {
        return undefined;
      }
    }
    const [row] = await database
      .select()
      .from(allowanceRefreshQuery(args.orgId));
    signal?.throwIfAborted();
    const prepared = await prepareAllowanceRefresh(row);
    signal?.throwIfAborted();
    return prepared;
  },
);

/** Refresh admission availability without reserving credit or opening a transaction. */
function allowanceAdmissionRefreshPlan(
  orgId: string,
  entitlement: {
    readonly id: string;
    readonly snapshot: string;
    readonly stripeSubscriptionId: string | null;
  },
  refresh: PreparedUsageAllowanceRefresh | undefined,
  at: Date,
) {
  if (!entitlement.stripeSubscriptionId) {
    return null;
  }
  if (
    refresh?.entitlementId !== entitlement.id ||
    refresh.snapshot !== entitlement.snapshot
  ) {
    throw new Error(
      "Usage allowance entitlement changed before prepared Stripe refresh",
    );
  }
  const subscription = refresh.subscription;
  const periodEnd = subscriptionScheduledEnd(subscription);
  const terminal = subscriptionIsTerminalAllowance(subscription);
  if (!terminal && !subscriptionCanBackUsageAllowance(subscription)) {
    L.warn("usage allowance subscription has unexpected Stripe status", {
      orgId: orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
    });
    return null;
  }
  if (
    !terminal &&
    (!periodEnd || periodEnd <= activeAllowanceCutoff(subscription.status, at))
  ) {
    L.warn("usage allowance subscription has no future paid-through period", {
      orgId: orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
      periodEnd,
    });
    return null;
  }

  return {
    terminal,
    status: terminal ? "canceled" : subscription.status,
    expiresAt: terminal ? at : periodEnd,
  };
}

export const refreshUsageAllowanceAvailability$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly refresh?: PreparedUsageAllowanceRefresh;
    },
    signal: AbortSignal,
  ): Promise<UsageAllowanceAvailability | null> => {
    const database = set(writeDb$);
    const at = nowDate();
    const [entitlement] = await database
      .select({
        id: orgUsageAllowanceEntitlements.id,
        status: orgUsageAllowanceEntitlements.status,
        expiresAt: orgUsageAllowanceEntitlements.expiresAt,
        shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
        weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
        stripeSubscriptionId:
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
        snapshot: sql`${orgUsageAllowanceEntitlements}::text`.mapWith(
          pgTextDecoder,
        ),
      })
      .from(orgUsageAllowanceEntitlements)
      .where(
        and(
          eq(orgUsageAllowanceEntitlements.orgId, args.orgId),
          inArray(orgUsageAllowanceEntitlements.status, [
            ...ACTIVE_ALLOWANCE_STATUSES,
          ]),
          lte(orgUsageAllowanceEntitlements.effectiveAt, at),
          or(
            isNull(orgUsageAllowanceEntitlements.expiresAt),
            gt(orgUsageAllowanceEntitlements.expiresAt, at),
            isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!entitlement) {
      return null;
    }
    if (
      entitlement.expiresAt &&
      entitlement.expiresAt <= activeAllowanceCutoff(entitlement.status, at)
    ) {
      const plan = allowanceAdmissionRefreshPlan(
        args.orgId,
        entitlement,
        args.refresh,
        at,
      );
      if (!plan) {
        return null;
      }
      const [updated] = await database
        .update(orgUsageAllowanceEntitlements)
        .set({
          status: plan.status,
          expiresAt: plan.expiresAt,
          updatedAt: at,
        })
        .where(
          and(
            eq(orgUsageAllowanceEntitlements.id, entitlement.id),
            eq(
              sql`${orgUsageAllowanceEntitlements}::text`,
              entitlement.snapshot,
            ),
          ),
        )
        .returning({ id: orgUsageAllowanceEntitlements.id });
      signal.throwIfAborted();
      if (!updated) {
        throw new Error(
          "Usage allowance entitlement changed during Stripe refresh",
        );
      }
      if (plan.terminal) {
        return null;
      }
    }
    // Admission is an observation, never a reservation. A later entitlement
    // change is still checked by the financial write's exact snapshot predicate.
    const windows = await database
      .select()
      .from(allowanceAvailabilityQuery(args.orgId, at));
    signal.throwIfAborted();
    const short = windows.find((row) => {
      return row.window?.kind === "short";
    })?.window;
    const weekly = windows.find((row) => {
      return row.window?.kind === "weekly";
    })?.window;
    const shortRemainingUnits =
      allowanceWindowRemainingUnits(short) ?? entitlement.shortWindowUnits;
    const weeklyRemainingUnits =
      allowanceWindowRemainingUnits(weekly) ?? entitlement.weeklyWindowUnits;
    return {
      shortRemainingUnits,
      weeklyRemainingUnits,
      remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
    };
  },
);

export type UsageAllowanceAvailabilitySnapshot =
  UsageAllowanceAvailability | "allowance_refresh_required" | null;
