import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  and,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { writeDb$, type Db } from "../external/db";
import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { safeSync } from "../utils";
import { getStripeClient } from "../external/stripe-client";

type UsageAllowanceStore = Pick<Db, "execute" | "insert" | "select" | "update">;

type UsageAllowanceWindowKind = "short" | "weekly";

const L = logger("UsageAllowance");
export const ACTIVE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
  "past_due",
  "unpaid",
] as const;
const TERMINAL_ALLOWANCE_STATUSES = ["canceled", "incomplete_expired"] as const;
const PAYMENT_FAILED_ALLOWANCE_STATUSES = ["past_due", "unpaid"] as const;
const PAYMENT_FAILURE_ALLOWANCE_GRACE_MS = 24 * 60 * 60 * 1000;

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

interface UsageAllowanceEntitlement {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
  readonly effectiveAt: Date;
  readonly expiresAt: Date | null;
  readonly stripeSubscriptionId: string | null;
  readonly snapshot: string;
}

interface UsageAllowanceWindow {
  readonly id: string;
  readonly kind: string;
  readonly unitLimit: number;
  readonly consumedUnits: number;
}

interface UsageAllowanceWindows {
  readonly shortWindow: UsageAllowanceWindow;
  readonly weeklyWindow: UsageAllowanceWindow;
}

interface UsageAllowanceAvailability {
  readonly remainingUnits: number;
  readonly shortRemainingUnits: number;
  readonly weeklyRemainingUnits: number;
}

function windowDurationSeconds(
  entitlement: UsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowSeconds
    : entitlement.weeklyWindowSeconds;
}

function windowUnitLimit(
  entitlement: UsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowUnits
    : entitlement.weeklyWindowUnits;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function entitlementCoversAt(
  entitlement: UsageAllowanceEntitlement,
  at: Date,
): boolean {
  return (
    entitlement.effectiveAt <= at &&
    (!entitlement.expiresAt || at < entitlement.expiresAt)
  );
}

function remainingUnits(
  window: Pick<UsageAllowanceWindow, "unitLimit" | "consumedUnits">,
): number {
  return Math.max(window.unitLimit - window.consumedUnits, 0);
}

function availabilityFromWindows(
  windows: UsageAllowanceWindows,
): UsageAllowanceAvailability {
  const shortRemainingUnits = remainingUnits(windows.shortWindow);
  const weeklyRemainingUnits = remainingUnits(windows.weeklyWindow);
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
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

function allowanceIsPaymentFailed(status: string): boolean {
  return PAYMENT_FAILED_ALLOWANCE_STATUSES.includes(
    status as (typeof PAYMENT_FAILED_ALLOWANCE_STATUSES)[number],
  );
}

export function activeAllowanceCutoff(status: string, now: Date): Date {
  return allowanceIsPaymentFailed(status)
    ? new Date(now.getTime() - PAYMENT_FAILURE_ALLOWANCE_GRACE_MS)
    : now;
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
async function prepareAllowanceRefresh(
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
    { set },
    args: {
      readonly orgId: string;
      readonly requirePendingUsage?: boolean;
      readonly idempotencyKeys?: readonly string[];
    },
    signal?: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (args.requirePendingUsage) {
      const [pending] = await db
        .select()
        .from(pendingAllowanceRefreshQuery(args.orgId, args.idempotencyKeys));
      signal?.throwIfAborted();
      if (!pending) {
        return undefined;
      }
    }
    const [row] = await db.select().from(allowanceRefreshQuery(args.orgId));
    signal?.throwIfAborted();
    const prepared = await prepareAllowanceRefresh(row);
    signal?.throwIfAborted();
    return prepared;
  },
);

async function applyPreparedUsageAllowanceRefresh(
  tx: UsageAllowanceStore,
  entitlement: UsageAllowanceEntitlement,
  now: Date,
  prepared: PreparedUsageAllowanceRefresh | undefined,
): Promise<UsageAllowanceEntitlement | null> {
  if (!entitlement.stripeSubscriptionId) {
    return null;
  }

  // An expired entitlement must be checked against the exact snapshot used
  // before Stripe I/O. A changed snapshot aborts the entire financial write;
  // it must never silently fall through to charging credits instead.
  if (
    prepared?.entitlementId !== entitlement.id ||
    prepared.snapshot !== entitlement.snapshot
  ) {
    throw new Error(
      "Usage allowance entitlement changed before prepared Stripe refresh",
    );
  }
  const unchanged = and(
    eq(orgUsageAllowanceEntitlements.id, entitlement.id),
    eq(sql`${orgUsageAllowanceEntitlements}::text`, entitlement.snapshot),
  );
  const subscription = prepared.subscription;
  const periodEnd = subscriptionScheduledEnd(subscription);

  if (subscriptionIsTerminalAllowance(subscription)) {
    const [canceled] = await tx
      .update(orgUsageAllowanceEntitlements)
      .set({
        status: "canceled",
        expiresAt: now,
        updatedAt: now,
      })
      .where(unchanged)
      .returning({ id: orgUsageAllowanceEntitlements.id });
    if (!canceled) {
      throw new Error(
        "Usage allowance entitlement changed during Stripe refresh",
      );
    }
    return null;
  }

  if (!subscriptionCanBackUsageAllowance(subscription)) {
    L.warn("usage allowance subscription has unexpected Stripe status", {
      orgId: entitlement.orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
    });
    return null;
  }

  const cutoff = activeAllowanceCutoff(subscription.status, now);
  if (!periodEnd || periodEnd <= cutoff) {
    L.warn("usage allowance subscription has no future paid-through period", {
      orgId: entitlement.orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
      periodEnd,
    });
    return null;
  }

  const [refreshed] = await tx
    .update(orgUsageAllowanceEntitlements)
    .set({
      status: subscription.status,
      expiresAt: periodEnd,
      updatedAt: now,
    })
    .where(unchanged)
    .returning({
      snapshot: sql`${orgUsageAllowanceEntitlements}::text`.mapWith(
        pgTextDecoder,
      ),
    });
  if (!refreshed) {
    // No charge or window allocation may use a stale Stripe result.
    throw new Error(
      "Usage allowance entitlement changed during Stripe refresh",
    );
  }
  return {
    ...entitlement,
    status: subscription.status,
    expiresAt: periodEnd,
    snapshot: refreshed.snapshot,
  };
}

export function orgCreditCompatibilityLockSql(orgId: string) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${orgId}))`;
}

export async function lockOrgCredits(
  tx: UsageAllowanceStore,
  orgId: string,
  scope: "settlement" | "allowance" = "allowance",
): Promise<void> {
  // DB/API rollout: outgoing settlement reads pending events before an
  // unconditional processed write and issues windows without row ownership.
  // Remove the advisory call only after pre-Release-1 serving/in-flight and
  // rollback writers are gone. Release 1/2 share the rows below and event CAS.
  await tx.execute(orgCreditCompatibilityLockSql(orgId));
  if (scope === "settlement") {
    // Settlement owns the balance before grant/expiry rows. Admission only
    // owns allowance; it can already hold a plan row and must not reverse the
    // billing metadata-before-plan order merely to inspect a window.
    await tx
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .for("update");
  }
  // The entitlement's existing unique organization identity owns creation of
  // its short/weekly windows, including the absence of a window for a run.
  await tx
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .for("update");
}

async function loadActiveUsageAllowanceEntitlement(
  tx: UsageAllowanceStore,
  orgId: string,
  refresh?: PreparedUsageAllowanceRefresh,
): Promise<UsageAllowanceEntitlement | null> {
  const currentTime = nowDate();
  const [row] = await tx
    .select({
      id: orgUsageAllowanceEntitlements.id,
      orgId: orgUsageAllowanceEntitlements.orgId,
      status: orgUsageAllowanceEntitlements.status,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      snapshot: sql`${orgUsageAllowanceEntitlements}::text`.mapWith(
        pgTextDecoder,
      ),
    })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, currentTime),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, currentTime),
          isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
        ),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const cutoff = activeAllowanceCutoff(row.status, currentTime);
  if (!row.expiresAt || row.expiresAt > cutoff) {
    return row;
  }
  return await applyPreparedUsageAllowanceRefresh(
    tx,
    row,
    currentTime,
    refresh,
  );
}

async function loadRunCreatedAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<Date | null> {
  const [row] = await tx
    .select({ createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, args.orgId), eq(agentRuns.id, args.runId)))
    .limit(1);
  return row?.createdAt ?? null;
}

async function lockActiveWindowAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<UsageAllowanceWindow | null> {
  const currentTime = nowDate();
  const [window] = await tx
    .select({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .innerJoin(
      orgUsageAllowanceEntitlements,
      eq(
        orgUsageAllowanceEntitlements.id,
        orgUsageAllowanceWindows.entitlementId,
      ),
    )
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceEntitlements.orgId, args.orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, currentTime),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, currentTime),
        ),
        gte(
          orgUsageAllowanceWindows.startsAt,
          orgUsageAllowanceEntitlements.effectiveAt,
        ),
        eq(orgUsageAllowanceWindows.kind, args.kind),
        lte(orgUsageAllowanceWindows.startsAt, args.at),
        gt(orgUsageAllowanceWindows.expiresAt, args.at),
      ),
    )
    .orderBy(desc(orgUsageAllowanceWindows.startsAt))
    .limit(1)
    .for("update");
  return window ?? null;
}

async function lockIssuedWindowAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<UsageAllowanceWindow | null> {
  const [window] = await tx
    .select({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceWindows.kind, args.kind),
        lte(orgUsageAllowanceWindows.startsAt, args.at),
        gt(orgUsageAllowanceWindows.expiresAt, args.at),
      ),
    )
    .orderBy(desc(orgUsageAllowanceWindows.startsAt))
    .limit(1)
    .for("update");
  return window ?? null;
}

async function insertWindow(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly startsAt: Date;
    readonly createdByRunId: string | null;
  },
): Promise<UsageAllowanceWindow> {
  const [window] = await tx
    .insert(orgUsageAllowanceWindows)
    .values({
      orgId: args.entitlement.orgId,
      entitlementId: args.entitlement.id,
      kind: args.kind,
      startsAt: args.startsAt,
      expiresAt: addSeconds(
        args.startsAt,
        windowDurationSeconds(args.entitlement, args.kind),
      ),
      unitLimit: windowUnitLimit(args.entitlement, args.kind),
      consumedUnits: 0,
      createdByRunId: args.createdByRunId,
    })
    .returning({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
      startsAt: orgUsageAllowanceWindows.startsAt,
      expiresAt: orgUsageAllowanceWindows.expiresAt,
    });
  if (!window) {
    throw new Error("Usage allowance window insert returned no row");
  }
  return window;
}

async function ensureWindowForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly runId: string;
    readonly runCreatedAt: Date;
  },
): Promise<UsageAllowanceWindow> {
  const existing = await lockActiveWindowAt(tx, {
    orgId: args.entitlement.orgId,
    kind: args.kind,
    at: args.runCreatedAt,
  });
  if (existing) {
    return existing;
  }

  return await insertWindow(tx, {
    entitlement: args.entitlement,
    kind: args.kind,
    startsAt: args.runCreatedAt,
    createdByRunId: args.runId,
  });
}

async function ensureWindowsForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly refresh?: PreparedUsageAllowanceRefresh;
    readonly runId: string;
    readonly runCreatedAt: Date;
  },
): Promise<UsageAllowanceWindows | null> {
  const entitlement = await loadActiveUsageAllowanceEntitlement(
    tx,
    args.orgId,
    args.refresh,
  );
  if (!entitlement || !entitlementCoversAt(entitlement, args.runCreatedAt)) {
    return null;
  }

  const shortWindow = await ensureWindowForRun(tx, {
    entitlement,
    kind: "short",
    runId: args.runId,
    runCreatedAt: args.runCreatedAt,
  });
  const weeklyWindow = await ensureWindowForRun(tx, {
    entitlement,
    kind: "weekly",
    runId: args.runId,
    runCreatedAt: args.runCreatedAt,
  });
  return { shortWindow, weeklyWindow };
}

async function loadExistingWindowsAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly at: Date;
  },
): Promise<UsageAllowanceWindows | null> {
  const shortWindow = await lockIssuedWindowAt(tx, {
    orgId: args.orgId,
    kind: "short",
    at: args.at,
  });
  const weeklyWindow = await lockIssuedWindowAt(tx, {
    orgId: args.orgId,
    kind: "weekly",
    at: args.at,
  });

  return shortWindow && weeklyWindow ? { shortWindow, weeklyWindow } : null;
}

async function readWindowAvailability(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<number> {
  const window = await lockActiveWindowAt(tx, {
    orgId: args.entitlement.orgId,
    kind: args.kind,
    at: args.at,
  });
  if (!window) {
    return windowUnitLimit(args.entitlement, args.kind);
  }
  return remainingUnits(window);
}

async function resolveAvailabilityInLockedTransaction(
  tx: UsageAllowanceStore,
  orgId: string,
  refresh?: PreparedUsageAllowanceRefresh,
): Promise<UsageAllowanceAvailability | null> {
  const entitlement = await loadActiveUsageAllowanceEntitlement(
    tx,
    orgId,
    refresh,
  );
  if (!entitlement) {
    return null;
  }
  const at = nowDate();
  const shortRemainingUnits = await readWindowAvailability(tx, {
    entitlement,
    kind: "short",
    at,
  });
  const weeklyRemainingUnits = await readWindowAvailability(tx, {
    entitlement,
    kind: "weekly",
    at,
  });
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

/** Read one admission snapshot without taking credit or allowance-window locks. */
export async function readUsageAllowanceAvailabilitySnapshot(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<UsageAllowanceAvailability | "allowance_refresh_required" | null> {
  const at = nowDate();
  const rows = await db
    .select({
      entitlement: {
        status: orgUsageAllowanceEntitlements.status,
        expiresAt: orgUsageAllowanceEntitlements.expiresAt,
        shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
        weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      },
      window: {
        kind: orgUsageAllowanceWindows.kind,
        unitLimit: orgUsageAllowanceWindows.unitLimit,
        consumedUnits: orgUsageAllowanceWindows.consumedUnits,
      },
    })
    .from(orgUsageAllowanceEntitlements)
    .leftJoin(
      orgUsageAllowanceWindows,
      and(
        eq(
          orgUsageAllowanceWindows.entitlementId,
          orgUsageAllowanceEntitlements.id,
        ),
        eq(orgUsageAllowanceWindows.orgId, orgId),
        inArray(orgUsageAllowanceWindows.kind, ["short", "weekly"]),
        gte(
          orgUsageAllowanceWindows.startsAt,
          orgUsageAllowanceEntitlements.effectiveAt,
        ),
        lte(orgUsageAllowanceWindows.startsAt, at),
        gt(orgUsageAllowanceWindows.expiresAt, at),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, at),
        ),
      ),
    )
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
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
    .orderBy(desc(orgUsageAllowanceWindows.startsAt));
  const entitlement = rows[0]?.entitlement;
  if (!entitlement) {
    return null;
  }
  if (
    entitlement.expiresAt &&
    entitlement.expiresAt <= activeAllowanceCutoff(entitlement.status, at)
  ) {
    return "allowance_refresh_required";
  }
  const shortWindow = rows.find((row) => {
    return row.window?.kind === "short";
  })?.window;
  const weeklyWindow = rows.find((row) => {
    return row.window?.kind === "weekly";
  })?.window;
  const shortRemainingUnits = shortWindow
    ? remainingUnits(shortWindow)
    : entitlement.shortWindowUnits;
  const weeklyRemainingUnits = weeklyWindow
    ? remainingUnits(weeklyWindow)
    : entitlement.weeklyWindowUnits;
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

export async function resolveUsageAllowanceAvailability(
  db: Db,
  orgId: string,
): Promise<UsageAllowanceAvailability | null> {
  const startedAt = performance.now();
  let lockWaitMs = 0;
  let availability = await readUsageAllowanceAvailabilitySnapshot(db, orgId);
  if (availability === "allowance_refresh_required") {
    const [row] = await db.select().from(allowanceRefreshQuery(orgId));
    const refresh = await prepareAllowanceRefresh(row);
    availability = await db.transaction(async (tx) => {
      const lockStartedAt = performance.now();
      await lockOrgCredits(tx, orgId);
      lockWaitMs = Math.round(performance.now() - lockStartedAt);
      return await resolveAvailabilityInLockedTransaction(tx, orgId, refresh);
    });
  }
  // Availability is a snapshot, not a reservation. Include any refresh COMMIT
  // in the timing; ordinary snapshots have no credit-lock wait.
  // Telemetry failure cannot deny admission; cancellation still propagates
  // via safeSync.
  safeSync(() => {
    recordBillingOperationTimings([
      {
        actionType: "api_billing_allowance_availability",
        durationMs: Math.round(performance.now() - startedAt),
        success: true,
        dimensions: { available: availability !== null },
      },
      {
        actionType: "api_billing_allowance_org_lock_wait",
        durationMs: lockWaitMs,
        success: true,
      },
    ]);
  });
  return availability;
}

export async function activateUsageAllowanceWindowsForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly runCreatedAt: Date;
    readonly refresh?: PreparedUsageAllowanceRefresh;
  },
): Promise<UsageAllowanceAvailability | null> {
  await lockOrgCredits(tx, args.orgId);
  const windows = await ensureWindowsForRun(tx, args);
  return windows ? availabilityFromWindows(windows) : null;
}

export async function resolveUsageAllowanceAvailabilityForRun(
  db: Db,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<UsageAllowanceAvailability | null> {
  const at = await loadRunCreatedAt(db, args);
  if (!at) {
    return null;
  }
  const issued = await loadExistingWindowsAt(db, { orgId: args.orgId, at });
  const [row] = issued
    ? []
    : await db.select().from(allowanceRefreshQuery(args.orgId));
  const refresh = await prepareAllowanceRefresh(row);
  return await db.transaction(async (tx) => {
    await lockOrgCredits(tx, args.orgId);
    const runCreatedAt = await loadRunCreatedAt(tx, args);
    if (!runCreatedAt) {
      return null;
    }
    const existingWindows = await loadExistingWindowsAt(tx, {
      orgId: args.orgId,
      at: runCreatedAt,
    });
    const windows =
      existingWindows ??
      (await ensureWindowsForRun(tx, { ...args, runCreatedAt, refresh }));
    return windows ? availabilityFromWindows(windows) : null;
  });
}
