import { pgTable } from "drizzle-orm/pg-core";

import { orgPlanEntitlementColumns } from "../columns/org-plan-entitlement";

/** Application mapping; excludes the legacy invitation columns retained for rollback APIs. */
export const orgPlanEntitlements = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementColumns(),
);
