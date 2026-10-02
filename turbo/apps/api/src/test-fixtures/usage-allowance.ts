/**
 * Narrow in-process fixtures for usage allowance state that has no equivalent
 * product-facing setup or read surface.
 *
 * Entitlements are created through Stripe webhooks. Explicit window seeds are
 * reserved for read scenarios that need pre-existing or historical state.
 */
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

interface UsageAllowanceWindowFixtureSeed {
  readonly kind: "short" | "weekly";
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly unitLimit: number;
  readonly consumedUnits?: number;
}

export async function insertUsageAllowanceWindowsFixture(values: {
  readonly orgId: string;
  readonly windows: readonly UsageAllowanceWindowFixtureSeed[];
}): Promise<void> {
  if (values.windows.length === 0) {
    return;
  }

  const db = createStore().set(writeDb$);
  const [entitlement] = await db
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, values.orgId))
    .limit(1);

  if (!entitlement) {
    throw new Error(
      `insertUsageAllowanceWindowsFixture: missing entitlement for ${values.orgId}`,
    );
  }

  await db.insert(orgUsageAllowanceWindows).values(
    values.windows.map((window) => {
      return {
        orgId: values.orgId,
        entitlementId: entitlement.id,
        kind: window.kind,
        startsAt: window.startsAt,
        expiresAt: window.expiresAt,
        unitLimit: window.unitLimit,
        consumedUnits: window.consumedUnits ?? 0,
      };
    }),
  );
}
