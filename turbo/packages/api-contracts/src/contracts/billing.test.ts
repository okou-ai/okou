import { describe, expect, it } from "vitest";

import { billingStatusContract, type BillingStatusResponse } from "./billing";
import { validateResponse } from "./trpc-contract";

const billingStatus: BillingStatusResponse = {
  tier: "pro",
  status: "active",
  canBuyConcurrency: true,
  concurrencyPurchaseReviewAvailable: true,
  canBuyCredits: true,
  showUsagePack: false,
  autoRechargeAllowed: true,
  restrictedBuiltInModels: false,
  workflowWebhookAutomationAllowed: true,
  credits: 12_000,
  onboardingPaymentPending: false,
  subscriptionStatus: "active",
  currentPeriodEnd: "2026-11-01T00:00:00Z",
  cancelAtPeriodEnd: false,
  scheduledChange: null,
  canRestorePlan: false,
  hasSubscription: true,
  autoRecharge: { enabled: false, threshold: null, amount: null },
  creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
  creditBreakdown: [
    { category: "plan", tier: "pro", label: "Pro credits", credits: 12_000 },
  ],
  creditGrants: [
    {
      id: "grant-pro",
      source: "subscription",
      label: "October Pro credits",
      amount: 20_000,
      remaining: 12_000,
      createdAt: "2026-10-01T00:00:00Z",
      expiresAt: "2026-11-01T00:00:00Z",
    },
  ],
  concurrencyLimit: 1,
  concurrencySubscriptions: [],
};

describe("Billing status responses", () => {
  it("validates a plan with its credit wallet and grants", () => {
    const response = validateResponse({
      appRoute: billingStatusContract.get,
      response: { status: 200, body: billingStatus },
    });

    expect(response.body).toEqual(billingStatus);
  });

  it("rejects invalid credit data", () => {
    expect(() => {
      validateResponse({
        appRoute: billingStatusContract.get,
        response: {
          status: 200,
          body: { ...billingStatus, credits: "12000" },
        },
      });
    }).toThrow("Response validation failed");
  });
});
