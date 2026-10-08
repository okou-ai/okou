import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { computed } from "ccstate";
import {
  and,
  desc,
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
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
} from "./usage-allowance-policy";
import {
  prepareAllowanceRefresh,
  remainingUnits,
  type PreparedUsageAllowanceRefresh,
} from "./usage-allowance.service";

export interface UsageAllowanceContext {
  readonly refresh: PreparedUsageAllowanceRefresh | undefined;
  readonly availability:
    | {
        readonly shortRemainingUnits: number;
        readonly weeklyRemainingUnits: number;
        readonly remainingUnits: number;
      }
    | "allowance_refresh_required"
    | null;
}

/** Org-only read: one entitlement snapshot feeds refresh and both admission checks. */
export function createUsageAllowanceContext(orgId: string) {
  return computed(async (get): Promise<UsageAllowanceContext> => {
    const at = nowDate();
    const rows = await get(db$)
      .select({
        entitlement: orgUsageAllowanceEntitlements,
        snapshot: sql`${orgUsageAllowanceEntitlements}::text`.mapWith(
          pgTextDecoder,
        ),
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
    const row = rows[0];
    if (!row) {
      return { refresh: undefined, availability: null };
    }
    const entitlement = row.entitlement;
    // subscriptions.retrieve is GET-only; no Stripe refresh/write is performed here.
    const refresh = await prepareAllowanceRefresh({
      ...entitlement,
      snapshot: row.snapshot,
    });
    if (
      entitlement.expiresAt &&
      entitlement.expiresAt <= activeAllowanceCutoff(entitlement.status, at)
    ) {
      return { refresh, availability: "allowance_refresh_required" };
    }
    const shortWindow = rows.find((entry) => {
      return entry.window?.kind === "short";
    })?.window;
    const weeklyWindow = rows.find((entry) => {
      return entry.window?.kind === "weekly";
    })?.window;
    const shortRemainingUnits = shortWindow
      ? remainingUnits(shortWindow)
      : entitlement.shortWindowUnits;
    const weeklyRemainingUnits = weeklyWindow
      ? remainingUnits(weeklyWindow)
      : entitlement.weeklyWindowUnits;
    return {
      refresh,
      availability: {
        shortRemainingUnits,
        weeklyRemainingUnits,
        remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
      },
    };
  });
}
