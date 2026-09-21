import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";

interface OrgTierLimits {
  readonly planRank: number;
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

/**
 * Tier values captured into org_plan_entitlements during billing writes.
 */
export const ORG_PLAN_ENTITLEMENT_TIER_VALUES: Readonly<
  Record<OrgTier, OrgTierLimits>
> = {
  free: {
    planRank: 0,
    baseConcurrencyLimit: 1,
    canBuyConcurrency: false,
    canBuyCredits: true,
    autoRechargeAllowed: false,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
    audioLifetimeLimit: 10,
    audioDailyRateLimit: 10,
    audioDailyDurationSeconds: 10 * 60,
  },
  "limited-free-1": {
    planRank: 0,
    baseConcurrencyLimit: 1,
    canBuyConcurrency: false,
    canBuyCredits: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedBuiltInModels: true,
    videoGenerationAllowed: false,
    workflowWebhookAutomationAllowed: false,
    audioLifetimeLimit: 10,
    audioDailyRateLimit: 10,
    audioDailyDurationSeconds: 10 * 60,
  },
  pro: {
    planRank: 1,
    baseConcurrencyLimit: 2,
    canBuyConcurrency: false,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 300,
    audioDailyDurationSeconds: 200 * 60,
  },
  team: {
    planRank: 2,
    baseConcurrencyLimit: 10,
    canBuyConcurrency: true,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 500,
    audioDailyDurationSeconds: 500 * 60,
  },
  custom: {
    planRank: 3,
    baseConcurrencyLimit: 10,
    canBuyConcurrency: true,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 500,
    audioDailyDurationSeconds: 500 * 60,
  },
};
