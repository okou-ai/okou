import { pgTable } from "drizzle-orm/pg-core";

import { orgPlanEntitlementColumns } from "../columns/org-plan-entitlement";

/** Application mapping for canonical organization entitlements. */
export const orgPlanEntitlements = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementColumns(),
);
