import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
  type UserFeatureSwitchOverrideRow,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { computed } from "ccstate";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";

import { userFeatureSwitchOverrides } from "./feature-switches.service";

interface StripeInvoiceFeatureOwner {
  readonly orgId: string;
  readonly userId: string;
}

export function stripeInvoicePaidFeatureReadPlan(
  owner: StripeInvoiceFeatureOwner,
) {
  return {
    columns: {
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    },
    condition: userFeatureSwitchRowCondition(owner.orgId, owner.userId),
  };
}

export function stripeInvoicePaidFeatureEnabledFromRows(
  owner: StripeInvoiceFeatureOwner,
  rows: readonly UserFeatureSwitchOverrideRow[],
): boolean {
  return isFeatureEnabled(
    FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
    featureSwitchContextFromRows(owner.orgId, owner.userId, rows),
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
