import {
  billingStatusContract,
  billingCheckoutContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
  billingUsagePackMigrationContract,
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingPortalContract,
  billingDowngradeContract,
  billingRestoreContract,
  billingAutoRechargeContract,
  billingInvoicesContract,
  billingRedeemContract,
  billingRedeemCodeContract,
  type BillingStatusResponse,
  type BillingInvoice,
  type RedeemResponse,
} from "@okouai/api-contracts/contracts/billing";
import { mockApi } from "../msw-contract.ts";

let mockBillingInvoices: BillingInvoice[] = [];

type BillingPlanCapabilities = Pick<
  BillingStatusResponse,
  | "status"
  | "canBuyConcurrency"
  | "concurrencyPurchaseReviewAvailable"
  | "canBuyCredits"
  | "autoRechargeAllowed"
  | "supportByok"
  | "restrictedBuiltInModels"
  | "videoGenerationAllowed"
  | "workflowWebhookAutomationAllowed"
  | "canRestorePlan"
>;

export function billingPlanCapabilities(tier: string): BillingPlanCapabilities {
  switch (tier) {
    case "free": {
      return {
        status: "active",
        canBuyConcurrency: false,
        concurrencyPurchaseReviewAvailable: false,
        canBuyCredits: true,
        autoRechargeAllowed: false,
        supportByok: true,
        restrictedBuiltInModels: false,
        videoGenerationAllowed: true,
        workflowWebhookAutomationAllowed: false,
        canRestorePlan: false,
      };
    }
    case "limited-free-1": {
      return {
        status: "active",
        canBuyConcurrency: false,
        concurrencyPurchaseReviewAvailable: false,
        canBuyCredits: false,
        autoRechargeAllowed: false,
        supportByok: false,
        restrictedBuiltInModels: true,
        videoGenerationAllowed: false,
        workflowWebhookAutomationAllowed: false,
        canRestorePlan: false,
      };
    }
    case "pro-suspend": {
      return {
        status: "suspended",
        canBuyConcurrency: false,
        concurrencyPurchaseReviewAvailable: false,
        canBuyCredits: false,
        autoRechargeAllowed: false,
        supportByok: true,
        restrictedBuiltInModels: false,
        videoGenerationAllowed: false,
        workflowWebhookAutomationAllowed: false,
        canRestorePlan: false,
      };
    }
    case "team":
    case "custom": {
      return {
        status: "active",
        canBuyConcurrency: true,
        concurrencyPurchaseReviewAvailable: false,
        canBuyCredits: true,
        autoRechargeAllowed: true,
        supportByok: true,
        restrictedBuiltInModels: false,
        videoGenerationAllowed: true,
        workflowWebhookAutomationAllowed: true,
        canRestorePlan: false,
      };
    }
    default: {
      return {
        status: "active",
        canBuyConcurrency: false,
        concurrencyPurchaseReviewAvailable: false,
        canBuyCredits: true,
        autoRechargeAllowed: true,
        supportByok: true,
        restrictedBuiltInModels: false,
        videoGenerationAllowed: true,
        workflowWebhookAutomationAllowed: false,
        canRestorePlan: false,
      };
    }
  }
}

function defaultBillingStatus(): BillingStatusResponse {
  return {
    tier: "pro-suspend",
    ...billingPlanCapabilities("pro-suspend"),
    showUsagePack: false,
    credits: 0,
    onboardingPaymentPending: true,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

let mockBillingStatus: BillingStatusResponse = defaultBillingStatus();

function defaultRedeemResponse(): RedeemResponse {
  return {
    status: "ready",
    checkoutUrl: "https://checkout.stripe.com/test/redeem",
  };
}

let mockRedeemResponse: RedeemResponse = defaultRedeemResponse();
let mockRedeemCodeHandler: ((code: string) => void) | null = null;

export function setMockRedeemResponse(response: RedeemResponse): void {
  mockRedeemResponse = response;
}

export function resetMockBilling(): void {
  mockBillingStatus = defaultBillingStatus();
  mockBillingInvoices = [];
  mockRedeemResponse = defaultRedeemResponse();
  mockRedeemCodeHandler = null;
}

export const apiBillingHandlers = [
  mockApi(billingStatusContract.get, ({ respond }) => {
    return respond(200, mockBillingStatus);
  }),

  mockApi(billingCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.com/test?tier=${body.tier}`,
    });
  }),

  mockApi(billingCheckoutContract.complete, ({ respond }) => {
    return respond(200, { completed: true });
  }),

  mockApi(billingUsagePackCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.com/test?usage-pack-tier=${body.tier}`,
    });
  }),

  mockApi(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
  }),

  mockApi(billingUsagePackMigrationContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Legacy subscription migration is not available",
        code: "NOT_FOUND",
      },
    });
  }),

  mockApi(billingConcurrencyCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.com/test?concurrency=${body.quantity}`,
    });
  }),

  mockApi(
    billingConcurrencySubscriptionContract.previewChange,
    ({ body, params, respond }) => {
      const subscription = mockBillingStatus.concurrencySubscriptions.find(
        (candidate) => {
          return candidate.id === params.subscriptionId;
        },
      );
      const currentQuantity = subscription?.quantity ?? 1;
      return respond(200, {
        currentQuantity,
        targetQuantity: body.quantity,
        immediateAmountCents:
          Math.max(0, body.quantity - currentQuantity) * 10_000,
        nextRecurringAmountCents: body.quantity * 10_000,
        currency: "usd",
      });
    },
  ),

  mockApi(
    billingConcurrencySubscriptionContract.confirmChange,
    ({ body, params, respond }) => {
      mockBillingStatus.concurrencySubscriptions =
        mockBillingStatus.concurrencySubscriptions.map((subscription) => {
          return subscription.id === params.subscriptionId
            ? { ...subscription, quantity: body.quantity }
            : subscription;
        });
      return respond(200, {
        status: "processing",
        hostedInvoiceUrl: null,
      });
    },
  ),

  mockApi(
    billingConcurrencySubscriptionContract.cancel,
    ({ params, respond }) => {
      mockBillingStatus.concurrencySubscriptions =
        mockBillingStatus.concurrencySubscriptions.map((subscription) => {
          if (subscription.id !== params.subscriptionId) {
            return subscription;
          }
          return {
            ...subscription,
            cancelAtPeriodEnd: true,
          };
        });
      const subscription = mockBillingStatus.concurrencySubscriptions.find(
        (candidate) => {
          return candidate.id === params.subscriptionId;
        },
      );
      return respond(200, {
        success: true,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      });
    },
  ),

  mockApi(
    billingConcurrencySubscriptionContract.restore,
    ({ params, respond }) => {
      mockBillingStatus.concurrencySubscriptions =
        mockBillingStatus.concurrencySubscriptions.map((subscription) => {
          if (subscription.id !== params.subscriptionId) {
            return subscription;
          }
          return {
            ...subscription,
            cancelAtPeriodEnd: false,
          };
        });
      return respond(200, {
        success: true,
      });
    },
  ),

  mockApi(billingPortalContract.create, ({ respond }) => {
    return respond(200, {
      url: "https://billing.stripe.com/test-portal",
    });
  }),

  mockApi(billingDowngradeContract.create, ({ respond }) => {
    return respond(200, {
      success: true,
      effectiveDate: null,
    });
  }),

  mockApi(billingRestoreContract.create, ({ respond }) => {
    mockBillingStatus.cancelAtPeriodEnd = false;
    mockBillingStatus.scheduledChange = null;
    return respond(200, { status: "restored" });
  }),

  mockApi(billingAutoRechargeContract.get, ({ respond }) => {
    return respond(200, mockBillingStatus.autoRecharge);
  }),

  mockApi(billingAutoRechargeContract.update, ({ body, respond }) => {
    mockBillingStatus.autoRecharge = {
      enabled: body.enabled,
      threshold: body.enabled ? (body.threshold ?? null) : null,
      amount: body.enabled ? (body.amount ?? null) : null,
    };
    return respond(200, mockBillingStatus.autoRecharge);
  }),

  mockApi(billingInvoicesContract.get, ({ respond }) => {
    return respond(200, {
      invoices: mockBillingInvoices,
      receiptDownloadsSupported: true,
    });
  }),

  mockApi(billingInvoicesContract.downloadReceipts, ({ respond }) => {
    return respond(
      200,
      new Blob(["mock receipts"], { type: "application/zip" }),
    );
  }),

  mockApi(billingRedeemContract.create, ({ respond }) => {
    return respond(200, mockRedeemResponse);
  }),

  mockApi(billingRedeemCodeContract.create, ({ body, respond }) => {
    mockRedeemCodeHandler?.(body.code);
    return respond(200, { redeemed: true });
  }),
];
