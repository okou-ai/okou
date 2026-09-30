import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";
import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
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
interface NewAllowanceWindow extends AllowanceWindow {
  readonly orgId: string;
  readonly entitlementId: string;
  readonly createdByRunId: string | null;
}
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

export function allocationQuery(events: readonly PricedUsageEvent[]) {
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
export function anchorQuery(
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

export function windowQuery(orgId: string, plan: AllowanceSettlementPlan) {
  const anchors = plan.candidates.map((candidate) => {
    return candidate.at.toISOString();
  });
  // Only the latest covering window of each kind can affect a candidate.
  // The existing org/kind/starts index serves each finite anchor lookup.
  // The UUID tie break matches latestWindow's stable sort over read rows.
  // Plain read: window creation is admitted by the (entitlement, kind, start)
  // unique identity and consumption is conditional on the consumed_units read
  // here, so a concurrent writer rejects this settlement's snapshot instead of
  // being blocked by an entitlement row lock.
  const selected = sql`SELECT chosen.id FROM unnest(${sql.param(anchors)}::timestamp[]) AS anchors(at)
    CROSS JOIN (VALUES ('short'), ('weekly')) AS kinds(kind)
    CROSS JOIN LATERAL (
      SELECT ${orgUsageAllowanceWindows.id} AS id FROM ${orgUsageAllowanceWindows}
      WHERE ${and(eq(orgUsageAllowanceWindows.orgId, orgId), eq(orgUsageAllowanceWindows.kind, sql`kinds.kind`), lte(orgUsageAllowanceWindows.startsAt, sql`anchors.at`), gt(orgUsageAllowanceWindows.expiresAt, sql`anchors.at`))}
      ORDER BY ${orgUsageAllowanceWindows.startsAt} DESC, ${orgUsageAllowanceWindows.id} ASC LIMIT 1
    ) AS chosen`;
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
    .where(sql`${orgUsageAllowanceWindows.id} IN (${selected})`)
    .orderBy(
      sql`CASE WHEN ${orgUsageAllowanceWindows.kind} = 'short' THEN 0 ELSE 1 END`,
      asc(orgUsageAllowanceWindows.id),
    )
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
    throw new UsageSettlementSnapshotConflict(
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
  const inserted: NewAllowanceWindow[] = [];
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
        // Allocation mutates the owned in-memory window. Keep the INSERT's
        // initial zero consumption independent; the delta applies exactly once.
        inserted.push({ ...window });
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
      const observed = before.get(window.id) ?? 0;
      return {
        id: window.id,
        observed,
        delta: window.consumedUnits - observed,
      };
    })
    .filter((window) => {
      return window.delta > 0;
    });
  return { allocations, changes, applied: plan.applied };
}

interface AllowanceConsumption {
  readonly id: string;
  readonly observed: number;
  readonly delta: number;
}

/**
 * Atomic, conditional increment: a window whose consumed_units moved since the
 * planning read (or since EvalPlanQual re-read it after a concurrent writer)
 * is skipped, and the caller rejects the snapshot on a short row count. The
 * planned delta was capped against the observed remainder, so a committed
 * increment can never overdraw the window.
 */
export function allowanceConsumptionSql(
  changes: readonly AllowanceConsumption[],
  at: Date,
) {
  return sql`UPDATE ${orgUsageAllowanceWindows} SET consumed_units = consumed_units + consumption.delta, updated_at = ${at.toISOString()}::timestamp
    FROM unnest(${sql.param(
      changes.map((change) => {
        return change.id;
      }),
    )}::uuid[], ${sql.param(
      changes.map((change) => {
        return change.observed;
      }),
    )}::bigint[], ${sql.param(
      changes.map((change) => {
        return change.delta;
      }),
    )}::bigint[]) AS consumption(id, observed, delta)
    WHERE ${orgUsageAllowanceWindows.id} = consumption.id
      AND ${orgUsageAllowanceWindows.consumedUnits} = consumption.observed`;
}

/**
 * Plain read, no row lock. Window creation is admitted by the unique
 * (entitlement_id, kind, starts_at) identity with INSERT … ON CONFLICT DO
 * NOTHING; a prepared Stripe refresh of the entitlement is conditional on the
 * row text read here. Either write reporting fewer rows than planned rejects
 * the settlement snapshot, which is then left for the next settlement cycle.
 */
export function entitlementQuery(orgId: string) {
  return new QueryBuilder()
    .select(allowanceEntitlementSelection())
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .as("settlement_entitlement");
}

/** A conditional write that affected fewer rows than planned rejects the snapshot. */
export function requireAllowanceWrite(
  kind: string,
  planned: number,
  updated: number | null,
) {
  if (updated !== planned) {
    throw new UsageSettlementSnapshotConflict(
      `Usage allowance ${kind} changed before settlement`,
    );
  }
}

export function planAllowanceWrites(
  scope: {
    readonly orgId: string;
    readonly at: Date;
    readonly refresh: PreparedUsageAllowanceRefresh | undefined;
  },
  plan: AllowanceSettlementPlan,
  windows: readonly AllowanceWindow[],
  entitlement: AllowanceEntitlement | undefined,
) {
  const args = { ...scope, plan, windows, entitlement };
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
  const refresh =
    prepared.update && current
      ? sql`UPDATE ${orgUsageAllowanceEntitlements}
    SET status = ${prepared.update.status}, expires_at = ${prepared.update.expiresAt.toISOString()}::timestamp,
      updated_at = ${args.at.toISOString()}::timestamp
    WHERE ${orgUsageAllowanceEntitlements.id} = ${current.id}
      AND ${orgUsageAllowanceEntitlements}::text = ${current.snapshot}`
      : null;
  // A fixed, finite SQL batch with the row count each statement must report.
  // The caller executes these statements directly inside its transaction and
  // compares the counts; this planner never receives a database handle.
  const writes = [
    ...(refresh ? [{ kind: "entitlement", sql: refresh, planned: 1 }] : []),
    {
      kind: "window",
      sql: insertWindowsSql(issued.inserted),
      planned: issued.inserted.length,
    },
    {
      kind: "consumption",
      sql: allowanceConsumptionSql(consumed.changes, args.at),
      planned: consumed.changes.length,
    },
    {
      kind: "allocation",
      sql: insertAllocationsSql(args.orgId, consumed.allocations),
      planned: consumed.allocations.length,
    },
  ];
  return { applied: consumed.applied, writes };
}

function insertWindowsSql(rows: readonly NewAllowanceWindow[]) {
  return sql`INSERT INTO ${orgUsageAllowanceWindows} (id, org_id, entitlement_id, kind, starts_at, expires_at, unit_limit, consumed_units, created_by_run_id)
    SELECT id, org_id, entitlement_id, kind, starts_at, expires_at, unit_limit, 0, run_id
    FROM unnest(${sql.param(
      rows.map((row) => {
        return row.id;
      }),
    )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.orgId;
        }),
      )}::text[],
      ${sql.param(
        rows.map((row) => {
          return row.entitlementId;
        }),
      )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.kind;
        }),
      )}::varchar[],
      ${sql.param(
        rows.map((row) => {
          return row.startsAt.toISOString();
        }),
      )}::timestamp[],
      ${sql.param(
        rows.map((row) => {
          return row.expiresAt.toISOString();
        }),
      )}::timestamp[],
      ${sql.param(
        rows.map((row) => {
          return row.unitLimit;
        }),
      )}::bigint[],
      ${sql.param(
        rows.map((row) => {
          return row.createdByRunId;
        }),
      )}::uuid[])
    AS issued(id, org_id, entitlement_id, kind, starts_at, expires_at, unit_limit, run_id)
    ON CONFLICT (entitlement_id, kind, starts_at) DO NOTHING`;
}

function insertAllocationsSql(
  orgId: string,
  rows: readonly (typeof usageAllowanceAllocations.$inferInsert)[],
) {
  return sql`INSERT INTO ${usageAllowanceAllocations} (usage_event_id, org_id, run_id, short_window_id, weekly_window_id, units_applied)
    SELECT usage_id, ${orgId}, run_id, short_id, weekly_id, units
    FROM unnest(${sql.param(
      rows.map((row) => {
        return row.usageEventId;
      }),
    )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.runId ?? null;
        }),
      )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.shortWindowId;
        }),
      )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.weeklyWindowId;
        }),
      )}::uuid[],
      ${sql.param(
        rows.map((row) => {
          return row.unitsApplied;
        }),
      )}::bigint[])
    AS allocations(usage_id, run_id, short_id, weekly_id, units)`;
}
