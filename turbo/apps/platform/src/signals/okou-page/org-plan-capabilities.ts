import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { computed } from "ccstate";

import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "./billing.ts";

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly showUsagePack: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
}

// Surface: new web/app -> old API. APIs from before #33658 step 1 send only
// the retired brand alias, so it is preferred over the tier table, which only
// covers responses carrying neither field. Remove with #33658 step 2 once
// restrictedBuiltInModels is required.
const LEGACY_TIER_RESTRICTED_BUILT_IN_MODELS: Readonly<
  Record<BillingTier, boolean>
> = {
  free: false,
  "limited-free-1": true,
  "pro-suspend": false,
  pro: false,
  team: false,
  custom: false,
};

export function orgPlanCapabilitiesFromBilling(
  billing: BillingStatusResponse,
): OrgPlanCapabilities {
  return {
    canBuyConcurrency: billing.canBuyConcurrency,
    canBuyCredits: billing.canBuyCredits,
    showUsagePack: billing.showUsagePack,
    status: billing.status,
    autoRechargeAllowed: billing.autoRechargeAllowed,
    supportByok: billing.supportByok,
    restrictedBuiltInModels:
      billing.restrictedBuiltInModels ??
      billing.restrictedVm0Models ??
      LEGACY_TIER_RESTRICTED_BUILT_IN_MODELS[
        apiTierToBillingTier(billing.tier)
      ],
    videoGenerationAllowed: billing.videoGenerationAllowed,
    workflowWebhookAutomationAllowed: billing.workflowWebhookAutomationAllowed,
  };
}

export const orgPlanCapabilities$ = computed(async (get) => {
  return orgPlanCapabilitiesFromBilling(await get(billingStatusAsync$));
});
