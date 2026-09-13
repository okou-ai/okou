import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { computed } from "ccstate";

import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "./billing.ts";

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
  /** Remove after APIs without billing status are below the rollback floor. */
  readonly legacyMemberInvitationAllowed: boolean | null;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly showUsagePack: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
}

const LEGACY_TIER_CAPABILITIES: Readonly<
  Record<BillingTier, Omit<OrgPlanCapabilities, "showUsagePack">>
> = {
  free: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
  },
  "limited-free-1": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    status: "active",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedBuiltInModels: true,
    videoGenerationAllowed: false,
    workflowWebhookAutomationAllowed: false,
  },
  "pro-suspend": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    status: "suspended",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    // Preserve the model picker behavior of browsers talking to an older API.
    // New APIs always return these two capabilities explicitly.
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: false,
    workflowWebhookAutomationAllowed: false,
  },
  pro: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
  },
  team: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
  },
  custom: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
  },
};

export function orgPlanCapabilitiesFromBilling(
  billing: BillingStatusResponse,
): OrgPlanCapabilities {
  const fallback = LEGACY_TIER_CAPABILITIES[apiTierToBillingTier(billing.tier)];
  const hasCurrentStatus = billing.status !== undefined;
  return {
    canBuyConcurrency: billing.canBuyConcurrency ?? fallback.canBuyConcurrency,
    canBuyCredits: billing.canBuyCredits ?? fallback.canBuyCredits,
    showUsagePack: billing.showUsagePack,
    status: billing.status ?? fallback.status,
    legacyMemberInvitationAllowed: hasCurrentStatus
      ? null
      : (billing.memberInvitationAllowed ??
        fallback.legacyMemberInvitationAllowed),
    autoRechargeAllowed:
      billing.autoRechargeAllowed ?? fallback.autoRechargeAllowed,
    supportByok: billing.supportByok ?? fallback.supportByok,
    // Surface: new web/app -> old API. APIs from before #33658 step 1 send
    // only the retired brand alias, so it is preferred over the tier table.
    // Remove once no such API is serving or retained for rollback: step 2.
    restrictedBuiltInModels:
      billing.restrictedBuiltInModels ??
      billing.restrictedVm0Models ??
      fallback.restrictedBuiltInModels,
    videoGenerationAllowed:
      billing.videoGenerationAllowed ?? fallback.videoGenerationAllowed,
    workflowWebhookAutomationAllowed:
      billing.workflowWebhookAutomationAllowed ??
      fallback.workflowWebhookAutomationAllowed,
  };
}

export const orgPlanCapabilities$ = computed(async (get) => {
  return orgPlanCapabilitiesFromBilling(await get(billingStatusAsync$));
});
