import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { computed } from "ccstate";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";

import type { ReadonlyDb } from "../external/db";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

export async function stripeInvoicePaidWorkflowAutomationEnabledForOwnerInDb(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const featureSwitchContextRows0 = await db
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(orgId, userId));
  return isFeatureEnabled(
    FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
    featureSwitchContextFromRows(orgId, userId, featureSwitchContextRows0),
  );
}

export function stripeInvoicePaidWorkflowAutomationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(
      FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
      { orgId, userId, overrides },
    );
  });
}
