import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { computed } from "ccstate";

import { billingStatusAsync$ } from "./billing.ts";

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
    restrictedBuiltInModels: billing.restrictedBuiltInModels,
    videoGenerationAllowed: billing.videoGenerationAllowed,
    workflowWebhookAutomationAllowed: billing.workflowWebhookAutomationAllowed,
  };
}

export const orgPlanCapabilities$ = computed(async (get) => {
  return orgPlanCapabilitiesFromBilling(await get(billingStatusAsync$));
});
