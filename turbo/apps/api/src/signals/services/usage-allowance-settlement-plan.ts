import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { PricedUsageEvent } from "./credit-usage-pricing";
import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
  type PreparedUsageAllowanceRefresh,
} from "./usage-allowance.service";

function allowanceEntitlementSelection() {
  return {
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
    snapshot: sql`${orgUsageAllowanceEntitlements}::text`
      .mapWith(pgTextDecoder)
      .as("snapshot"),
  };
}
export type AllowanceEntitlement = Pick<
  typeof orgUsageAllowanceEntitlements.$inferSelect,
  | "id"
  | "orgId"
  | "status"
  | "shortWindowSeconds"
  | "shortWindowUnits"
  | "weeklyWindowSeconds"
  | "weeklyWindowUnits"
  | "effectiveAt"
  | "expiresAt"
  | "stripeSubscriptionId"
> & { readonly snapshot: string };
type AllowanceWindow = Pick<
  typeof orgUsageAllowanceWindows.$inferSelect,
  "id" | "kind" | "startsAt" | "expiresAt" | "unitLimit" | "consumedUnits"
>;
interface Candidate {
  readonly usageEventId: string;
  readonly runId: string | null;
  readonly grossUnits: number;
  readonly at: Date;
}
export interface AllowanceSettlementPlan {
  readonly candidates: readonly Candidate[];
  readonly applied: Map<string, number>;
}

export function allowanceAllocationQuery(events: readonly PricedUsageEvent[]) {
  return new QueryBuilder()
    .select({
      usageEventId: usageAllowanceAllocations.usageEventId,
      unitsApplied: usageAllowanceAllocations.unitsApplied,
    })
    .from(usageAllowanceAllocations)
    .where(
      inArray(
        usageAllowanceAllocations.usageEventId,
        events
          .filter((event) => {
            return event.grossCredits > 0;
          })
          .map((event) => {
            return event.record.id;
          }),
      ),
    )
    .as("settlement_allocations");
}

// Keep the existing live-Run anchor fallback until the complete attribution
// inventory proves pending_anchor_gaps: 0; neither age nor this refactor does.
export function allowanceAnchorQuery(
  orgId: string,
  events: readonly PricedUsageEvent[],
) {
  return new QueryBuilder()
    .select({ id: agentRuns.id, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(
          agentRuns.id,
          events.flatMap((event) => {
            return event.grossCredits > 0 &&
              event.record.runId &&
              !event.record.billingAnchorAt
              ? [event.record.runId]
              : [];
          }),
        ),
      ),
    )
    .as("settlement_anchors");
}

export function planAllowanceCandidates(
  events: readonly PricedUsageEvent[],
  allocations: readonly { usageEventId: string; unitsApplied: number }[],
  anchors: readonly { id: string; createdAt: Date }[],
): AllowanceSettlementPlan {
  const applied = new Map(
    allocations.map((allocation) => {
      return [allocation.usageEventId, allocation.unitsApplied];
    }),
  );
  const runTimes = new Map(
    anchors.map((run) => {
      return [run.id, run.createdAt];
    }),
  );
  return {
    applied,
    candidates: events
      .filter((event) => {
        return event.grossCredits > 0 && !applied.has(event.record.id);
      })
      .map((event) => {
        return {
          usageEventId: event.record.id,
          runId: event.record.runId,
          grossUnits: event.grossCredits,
          at:
            event.record.billingAnchorAt ??
            (event.record.runId
              ? runTimes.get(event.record.runId)
              : undefined) ??
            event.record.createdAt,
        };
      }),
  };
}

export function allowanceWindowsQuery(
  orgId: string,
  plan: AllowanceSettlementPlan,
) {
  const times = plan.candidates.map((candidate) => {
    return candidate.at.getTime();
  });
  return new QueryBuilder()
    .select({
      id: orgUsageAllowanceWindows.id,
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
        inArray(orgUsageAllowanceWindows.kind, ["short", "weekly"]),
        times.length === 0
          ? sql`false`
          : and(
              lte(
                orgUsageAllowanceWindows.startsAt,
                new Date(Math.max(...times)),
              ),
              gt(
                orgUsageAllowanceWindows.expiresAt,
                new Date(Math.min(...times)),
              ),
            ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${orgUsageAllowanceWindows.kind} = 'short' THEN 0 ELSE 1 END`,
      asc(orgUsageAllowanceWindows.id),
    )
    .for("update")
    .as("settlement_windows");
}

function latestWindow(
  windows: readonly AllowanceWindow[],
  kind: string,
  at: Date,
) {
  return windows
    .filter((window) => {
      return (
        window.kind === kind && window.startsAt <= at && window.expiresAt > at
      );
    })
    .sort((left, right) => {
      return right.startsAt.getTime() - left.startsAt.getTime();
    })[0];
}

export function allowanceNeedsWindows(
  plan: AllowanceSettlementPlan,
  windows: readonly AllowanceWindow[],
) {
  return plan.candidates.some((candidate) => {
    return (
      !latestWindow(windows, "short", candidate.at) ||
      !latestWindow(windows, "weekly", candidate.at)
    );
  });
}

export function activeAllowanceEntitlementCondition(orgId: string, at: Date) {
  return and(
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
  );
}

export function planPreparedAllowanceEntitlement(
  entitlement: AllowanceEntitlement | undefined,
  refresh: PreparedUsageAllowanceRefresh | undefined,
  at: Date,
) {
  if (
    !entitlement ||
    !entitlement.expiresAt ||
    entitlement.expiresAt > activeAllowanceCutoff(entitlement.status, at)
  ) {
    return { entitlement: entitlement ?? null, update: null };
  }
  if (!entitlement.stripeSubscriptionId) {
    return { entitlement: null, update: null };
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
  if (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  ) {
    return {
      entitlement: null,
      update: { status: "canceled", expiresAt: at, updatedAt: at },
    };
  }
  const end = subscription.items.data[0]?.current_period_end;
  const expiresAt =
    typeof end === "number"
      ? new Date(Math.min(end, subscription.cancel_at ?? end) * 1000)
      : null;
  if (
    !ACTIVE_ALLOWANCE_STATUSES.some((status) => {
      return status === subscription.status;
    }) ||
    !expiresAt ||
    expiresAt <= activeAllowanceCutoff(subscription.status, at)
  ) {
    return { entitlement: null, update: null };
  }
  const update = { status: subscription.status, expiresAt, updatedAt: at };
  return { entitlement: { ...entitlement, ...update }, update };
}

export function planNewAllowanceWindows(
  orgId: string,
  plan: AllowanceSettlementPlan,
  existing: readonly AllowanceWindow[],
  entitlement: AllowanceEntitlement | null,
) {
  const windows = existing.map((window) => {
    return { ...window };
  });
  const inserted: (typeof orgUsageAllowanceWindows.$inferInsert)[] = [];
  if (entitlement) {
    const candidates = [...plan.candidates].sort((left, right) => {
      return left.at.getTime() - right.at.getTime();
    });
    for (const kind of ["short", "weekly"] as const) {
      for (const candidate of candidates) {
        if (
          latestWindow(windows, kind, candidate.at) ||
          entitlement.effectiveAt > candidate.at ||
          (entitlement.expiresAt && entitlement.expiresAt <= candidate.at)
        ) {
          continue;
        }
        const window = {
          id: randomUUID(),
          orgId,
          entitlementId: entitlement.id,
          kind,
          startsAt: candidate.at,
          expiresAt: new Date(
            candidate.at.getTime() +
              1000 *
                (kind === "short"
                  ? entitlement.shortWindowSeconds
                  : entitlement.weeklyWindowSeconds),
          ),
          unitLimit:
            kind === "short"
              ? entitlement.shortWindowUnits
              : entitlement.weeklyWindowUnits,
          consumedUnits: 0,
          createdByRunId: candidate.runId,
        };
        windows.push(window);
        inserted.push(window);
      }
    }
  }
  return { windows, inserted };
}

export function planAllowanceConsumption(
  orgId: string,
  plan: AllowanceSettlementPlan,
  windows: AllowanceWindow[],
) {
  const before = new Map(
    windows.map((window) => {
      return [window.id, window.consumedUnits];
    }),
  );
  const allocations: (typeof usageAllowanceAllocations.$inferInsert)[] = [];
  for (const candidate of plan.candidates) {
    const shortWindow = latestWindow(windows, "short", candidate.at);
    const weeklyWindow = latestWindow(windows, "weekly", candidate.at);
    if (!shortWindow || !weeklyWindow) {
      continue;
    }
    const unitsApplied = Math.min(
      candidate.grossUnits,
      Math.max(0, shortWindow.unitLimit - shortWindow.consumedUnits),
      Math.max(0, weeklyWindow.unitLimit - weeklyWindow.consumedUnits),
    );
    if (unitsApplied <= 0) {
      continue;
    }
    shortWindow.consumedUnits += unitsApplied;
    weeklyWindow.consumedUnits += unitsApplied;
    plan.applied.set(candidate.usageEventId, unitsApplied);
    allocations.push({
      orgId,
      usageEventId: candidate.usageEventId,
      runId: candidate.runId,
      shortWindowId: shortWindow.id,
      weeklyWindowId: weeklyWindow.id,
      unitsApplied,
    });
  }
  const changes = windows
    .map((window) => {
      return {
        id: window.id,
        delta: window.consumedUnits - (before.get(window.id) ?? 0),
      };
    })
    .filter((window) => {
      return window.delta > 0;
    });
  return { allocations, changes, applied: plan.applied };
}

export function allowanceConsumptionSql(
  changes: readonly { readonly id: string; readonly delta: number }[],
  at: Date,
) {
  return sql`UPDATE ${orgUsageAllowanceWindows} SET consumed_units = consumed_units + consumption.delta, updated_at = ${at.toISOString()}::timestamp
    FROM unnest(${sql.param(
      changes.map((change) => {
        return change.id;
      }),
    )}::uuid[], ${sql.param(
      changes.map((change) => {
        return change.delta;
      }),
    )}::bigint[]) AS consumption(id, delta)
    WHERE ${orgUsageAllowanceWindows.id} = consumption.id`;
}

export function allowanceEntitlementQuery(orgId: string) {
  return new QueryBuilder()
    .select(allowanceEntitlementSelection())
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .for("update")
    .as("settlement_entitlement");
}

export function planAllowanceWrites(args: {
  readonly orgId: string;
  readonly plan: AllowanceSettlementPlan;
  readonly windows: readonly AllowanceWindow[];
  readonly entitlement: AllowanceEntitlement | undefined;
  readonly refresh: PreparedUsageAllowanceRefresh | undefined;
  readonly at: Date;
}) {
  const current = args.entitlement;
  const active =
    current &&
    ACTIVE_ALLOWANCE_STATUSES.some((status) => {
      return status === current.status;
    }) &&
    current.effectiveAt <= args.at &&
    (!current.expiresAt ||
      current.expiresAt > args.at ||
      current.stripeSubscriptionId);
  const prepared = planPreparedAllowanceEntitlement(
    active && allowanceNeedsWindows(args.plan, args.windows)
      ? current
      : undefined,
    args.refresh,
    args.at,
  );
  const issued = planNewAllowanceWindows(
    args.orgId,
    args.plan,
    args.windows,
    prepared.entitlement,
  );
  const consumed = planAllowanceConsumption(
    args.orgId,
    args.plan,
    issued.windows,
  );
  return {
    ...consumed,
    inserted: issued.inserted,
    entitlementUpdate: prepared.update,
  };
}
