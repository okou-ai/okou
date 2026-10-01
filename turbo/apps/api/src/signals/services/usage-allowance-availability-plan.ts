import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
} from "./usage-allowance.service";
import type { AllowanceEntitlement } from "./usage-allowance-settlement-plan";

interface AllowanceAvailabilityRow {
  readonly entitlement: {
    readonly status: string;
    readonly expiresAt: Date | null;
    readonly shortWindowUnits: number;
    readonly weeklyWindowUnits: number;
  };
  readonly window: {
    readonly kind: string | null;
    readonly unitLimit: number | null;
    readonly consumedUnits: number | null;
  } | null;
}
export interface AllowanceAvailability {
  readonly remainingUnits: number;
  readonly shortRemainingUnits: number;
  readonly weeklyRemainingUnits: number;
}
function remainingUnits(
  window: AllowanceAvailabilityRow["window"] | undefined,
) {
  return window?.unitLimit === null ||
    window?.unitLimit === undefined ||
    window.consumedUnits === null
    ? undefined
    : Math.max(0, window.unitLimit - window.consumedUnits);
}
export function allowanceAvailabilityQuery(orgId: string, at: Date) {
  // Admission needs at most one covering window of each kind. Use the same
  // start-time/UUID order as settlement, including overlapping legacy windows.
  const selected = sql`SELECT chosen.id
    FROM (VALUES ('short'), ('weekly')) AS kinds(kind)
    CROSS JOIN LATERAL (
      SELECT ${orgUsageAllowanceWindows.id} AS id
      FROM ${orgUsageAllowanceWindows}
      WHERE ${and(
        eq(
          orgUsageAllowanceWindows.entitlementId,
          orgUsageAllowanceEntitlements.id,
        ),
        eq(orgUsageAllowanceWindows.orgId, orgId),
        eq(orgUsageAllowanceWindows.kind, sql`kinds.kind`),
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
      )}
      ORDER BY ${orgUsageAllowanceWindows.startsAt} DESC, ${orgUsageAllowanceWindows.id} ASC
      LIMIT 1
    ) AS chosen`;
  return new QueryBuilder()
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
      sql`${orgUsageAllowanceWindows.id} IN (${selected})`,
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
    .as("allowance_availability");
}
export function allowanceAvailability(
  rows: readonly AllowanceAvailabilityRow[],
  at: Date,
): AllowanceAvailability | "allowance_refresh_required" | null {
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
  const shortRemainingUnits =
    remainingUnits(shortWindow) ?? entitlement.shortWindowUnits;
  const weeklyRemainingUnits =
    remainingUnits(weeklyWindow) ?? entitlement.weeklyWindowUnits;
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

export function currentAllowanceEntitlement(
  entitlement: AllowanceEntitlement | undefined,
  at: Date,
) {
  return entitlement &&
    ACTIVE_ALLOWANCE_STATUSES.some((status) => {
      return status === entitlement.status;
    }) &&
    entitlement.effectiveAt <= at &&
    (!entitlement.expiresAt ||
      entitlement.expiresAt > at ||
      entitlement.stripeSubscriptionId)
    ? entitlement
    : undefined;
}
