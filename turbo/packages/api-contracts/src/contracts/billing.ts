import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { usagePackUsdSchema } from "../validators/billing";

export {
  USAGE_PACKS_USD,
  type UsagePackUsd,
  usagePackUsdSchema,
} from "../validators/billing";

const c = initContract();

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const autoRechargeSchema = object({
  enabled: boolean(),
  threshold: number().nullable(),
  amount: number().nullable(),
});

const creditExpirySchema = object({
  expiringNextCycle: number(),
  nextExpiryDate: string().nullable(),
});

const creditBreakdownSegmentSchema = object({
  category: zEnum(["plan", "free", "promotional", "payAsYouGo"]),
  label: string(),
  credits: number(),
  // Only set on `plan` segments. Lets the UI decide whether a segment
  // represents the current plan or leftover credits from a previous plan
  // without round-tripping through the `label` string.
  tier: zEnum(["pro", "team"]).optional(),
});

const creditGrantSchema = object({
  id: string(),
  source: string(),
  label: string(),
  amount: number(),
  remaining: number(),
  createdAt: string(),
  expiresAt: string(),
});

const scheduledBillingChangeSchema = object({
  type: zEnum(["cancel", "downgrade"]),
  targetTier: zEnum(["limited-free-1", "pro", "team"]).nullable(),
  effectiveDate: string().nullable(),
});

const concurrencySubscriptionSchema = object({
  id: string(),
  quantity: number().int().nonnegative(),
  currentPeriodEnd: string().nullable(),
  cancelAtPeriodEnd: boolean(),
  canReduce: boolean().optional(),
  // Emitted for every subscription that is not cancelling, like `canReduce`.
  // It stays optional so a new app reaching a draining older API still parses
  // the response; no client branches on its absence since #26152.
  canChangeInApp: boolean().optional(),
  // The API omits both fields whenever no concurrency change is scheduled
  // (billing-status.service.ts spreads them only for a scheduled change), so
  // they are genuinely optional rather than a rollout tolerance.
  scheduledQuantity: number().int().positive().nullable().optional(),
  scheduledChangeAt: string().nullable().optional(),
});

const billingStatusResponseSchema = object({
  tier: string(),
  status: zEnum(["active", "suspended"]),
  canBuyConcurrency: boolean(),
  // The current API omits the amount when the configured Stripe Price is
  // unavailable.
  concurrencyUnitAmountCents: number().int().positive().optional(),
  concurrencyPurchaseReviewAvailable: boolean(),
  canBuyCredits: boolean(),
  showUsagePack: boolean(),
  autoRechargeAllowed: boolean(),
  restrictedBuiltInModels: boolean(),
  workflowWebhookAutomationAllowed: boolean(),
  credits: number(),
  onboardingPaymentPending: boolean(),
  subscriptionStatus: string().nullable(),
  currentPeriodEnd: string().nullable(),
  cancelAtPeriodEnd: boolean(),
  scheduledChange: scheduledBillingChangeSchema.nullable(),
  canRestorePlan: boolean(),
  hasSubscription: boolean(),
  autoRecharge: autoRechargeSchema,
  creditExpiry: creditExpirySchema,
  creditBreakdown: array(creditBreakdownSegmentSchema),
  creditGrants: array(creditGrantSchema),
  concurrencyLimit: number().int().nonnegative(),
  concurrencySubscriptions: array(concurrencySubscriptionSchema),
});

const checkoutResponseSchema = object({
  url: string(),
});

const subscriptionPurchasePreviewBaseSchema = object({
  status: literal("preview"),
  tier: zEnum(["pro", "team"]),
  immediateAmountCents: number().int().nonnegative(),
  nextRecurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  expiresAt: iso.datetime(),
  previewToken: string().min(1),
});

const planPurchasePreviewResponseSchema =
  subscriptionPurchasePreviewBaseSchema.extend({
    purchaseType: literal("plan"),
    trialDays: literal(7).optional(),
  });

const usagePackPurchasePreviewResponseSchema =
  subscriptionPurchasePreviewBaseSchema.extend({
    purchaseType: literal("usage_pack"),
  });

const billingPurchaseConfirmResponseSchema = discriminatedUnion("status", [
  object({
    status: literal("completed"),
    hostedInvoiceUrl: zNull(),
  }),
  object({
    status: literal("pending_payment"),
    hostedInvoiceUrl: url(),
  }),
  object({
    status: literal("checkout_required"),
    checkoutUrl: url(),
  }),
]);

const checkoutCompleteResponseSchema = object({
  completed: boolean(),
});

const redeemCodeResponseSchema = object({
  redeemed: literal(true),
});

const portalResponseSchema = object({
  url: string(),
});

const redeemResponseSchema = discriminatedUnion("status", [
  object({
    status: literal("ready"),
    checkoutUrl: url(),
  }),
  object({
    status: literal("already_granted"),
  }),
  object({
    status: literal("processing"),
  }),
  object({
    status: literal("error"),
    reason: zEnum([
      "campaign_misconfigured",
      "admin_required",
      "billing_unavailable",
    ]),
  }),
]);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const stripeRedirectUrlSchema = url().max(5000);

const checkoutRequestSchema = object({
  tier: zEnum(["pro", "team"]),
  supportsInAppPreview: boolean().optional(),
  previewToken: string().min(1).optional(),
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
  trialDays: literal(7).optional(),
});

const usagePackCatalogItemSchema = object({
  usagePackUsd: usagePackUsdSchema,
  priceUsd: number().positive(),
  purchasedCredits: number().int().positive(),
  bonusCredits: number().int().positive(),
  totalCredits: number().int().positive(),
});

const usagePackCatalogResponseSchema = object({
  usagePacks: array(usagePackCatalogItemSchema),
  supportsFreeMembers: literal(true),
});

const usagePackCreditBalanceSchema = object({
  totalCredits: number().int().nonnegative(),
  purchasedCredits: number().int().nonnegative(),
  bonusCredits: number().int().nonnegative(),
  creditGrants: array(
    object({
      id: string(),
      grantType: zEnum(["purchased", "bonus"]),
      amount: number().int().positive(),
      remaining: number().int().positive(),
      createdAt: string(),
      expiresAt: string(),
    }),
  ),
});

const usagePackCreditsResponseSchema = usagePackCreditBalanceSchema.extend({
  hasUsagePack: boolean().optional(),
  memberCredits: array(
    usagePackCreditBalanceSchema.extend({
      memberId: string().min(1),
    }),
  ).optional(),
});

const memberUsagePackSchema = object({
  memberId: string().min(1),
  // Free members have no paid allocation or Stripe usage pack item.
  usagePackUsd: union([literal(0), usagePackUsdSchema]),
});
export type MemberUsagePack = zInfer<typeof memberUsagePackSchema>;
export type UsagePackCatalogItem = zInfer<typeof usagePackCatalogItemSchema>;

const usagePackCheckoutRequestSchema = object({
  tier: zEnum(["pro", "team"]),
  supportsInAppPreview: boolean().optional(),
  previewToken: string().min(1).optional(),
  memberUsagePacks: array(memberUsagePackSchema).min(1).max(1000),
  successUrl: url(),
  cancelUrl: url(),
});

const usagePackChangeStatusSchema = zEnum([
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
]);

const usagePackPendingChangeSchema = object({
  id: uuid(),
  kind: zEnum(["addition", "upgrade", "downgrade", "removal"]),
  status: usagePackChangeStatusSchema,
  targetUsagePackUsd: usagePackUsdSchema.nullable(),
  effectiveAt: iso.datetime().nullable(),
});

const managedUsagePackAllocationSchema = object({
  id: uuid(),
  memberId: string().min(1),
  usagePackUsd: usagePackUsdSchema,
  currentPeriodEnd: iso.datetime().nullable(),
  pendingChange: usagePackPendingChangeSchema.nullable(),
});

const usagePackManagementResponseSchema = object({
  tier: zEnum(["pro", "team"]),
  currentPeriodEnd: iso.datetime().nullable(),
  supportsMemberAdditions: boolean().optional(),
  supportsFreeMembers: literal(true),
  allocations: array(managedUsagePackAllocationSchema),
});

const usagePackChangePreviewRequestSchema = object({
  memberId: string().min(1),
  targetUsagePackUsd: usagePackUsdSchema,
  supportsInAppPreview: boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const usagePackChangePreviewResponseSchema = object({
  changeId: uuid(),
  kind: zEnum(["upgrade", "downgrade"]),
  sourceUsagePackUsd: usagePackUsdSchema,
  targetUsagePackUsd: usagePackUsdSchema,
  immediateAmountCents: number().int().nonnegative(),
  nextRecurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  effectiveAt: iso.datetime().nullable(),
  prorationDate: iso.datetime(),
  expiresAt: iso.datetime(),
  paymentMethodPreviewToken: string().min(1).optional(),
  checkoutUrl: url().optional(),
});

const usagePackChangeConfirmResponseSchema = union([
  object({
    status: zEnum(["processing", "pending_payment", "scheduled", "completed"]),
    effectiveAt: iso.datetime().nullable(),
    hostedInvoiceUrl: url().nullable(),
  }),
  object({
    status: literal("checkout_required"),
    checkoutUrl: url(),
  }),
]);

const usagePackSubscriptionChangePreviewRequestSchema = object({
  targetTier: zEnum(["pro", "team"]),
  memberUsagePacks: array(memberUsagePackSchema).min(1).max(1000),
  supportsInAppPreview: boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const usagePackSubscriptionChangePreviewResponseSchema = object({
  changeId: uuid(),
  sourceTier: zEnum(["pro", "team"]),
  targetTier: zEnum(["pro", "team"]),
  immediateAmountCents: number().int().nonnegative(),
  immediateCreditGrant: object({
    purchasedCredits: number().int().nonnegative(),
    bonusCredits: number().int().nonnegative(),
    totalCredits: number().int().nonnegative(),
    expiresAt: iso.datetime().optional(),
  }).optional(),
  nextRecurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  effectiveAt: iso.datetime(),
  prorationDate: iso.datetime(),
  expiresAt: iso.datetime(),
  paymentMethodPreviewToken: string().min(1).optional(),
  checkoutUrl: url().optional(),
});

const usagePackSubscriptionChangeConfirmRequestSchema = object({
  changeId: uuid(),
  paymentMethodPreviewToken: string().min(1).optional(),
});

export type UsagePackManagementResponse = zInfer<
  typeof usagePackManagementResponseSchema
>;
export type UsagePackChangePreviewResponse = zInfer<
  typeof usagePackChangePreviewResponseSchema
>;
export type UsagePackChangeConfirmResponse = zInfer<
  typeof usagePackChangeConfirmResponseSchema
>;
export type UsagePackSubscriptionChangePreviewResponse = zInfer<
  typeof usagePackSubscriptionChangePreviewResponseSchema
>;

export const usagePackMigrationConfigurationSchema = object({
  tier: zEnum(["pro", "team"]),
  memberUsagePacks: array(memberUsagePackSchema).max(1000),
  recurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
});

export type UsagePackMigrationConfiguration = zInfer<
  typeof usagePackMigrationConfigurationSchema
>;

const usagePackMigrationStateResponseSchema = object({
  tier: zEnum(["pro", "team"]),
  targetTier: zEnum(["pro", "team"]).nullable(),
  status: zEnum(["eligible", "previewed", "applying", "scheduled"]),
  migrationId: uuid().nullable(),
  effectiveAt: iso.datetime().nullable(),
  hostedInvoiceUrl: url().nullable(),
  configuration: usagePackMigrationConfigurationSchema.optional(),
});

const usagePackMigrationPreviewRequestSchema = object({
  targetTier: zEnum(["pro", "team"]),
  memberUsagePacks: array(memberUsagePackSchema).min(1).max(1000),
});

const usagePackMigrationPreviewResponseSchema = object({
  migrationId: uuid(),
  tier: zEnum(["pro", "team"]),
  targetTier: zEnum(["pro", "team"]),
  currentRecurringAmountCents: number().int().nonnegative(),
  nextRecurringAmountCents: number().int().nonnegative(),
  recurringDifferenceCents: number().int(),
  currency: string().length(3),
  purchasedCredits: number().int().nonnegative(),
  bonusCredits: number().int().nonnegative(),
  totalCredits: number().int().nonnegative(),
  effectiveAt: iso.datetime(),
  expiresAt: iso.datetime(),
});

const usagePackMigrationConfirmResponseSchema = object({
  status: zEnum(["scheduled", "completed"]),
  effectiveAt: iso.datetime(),
  hostedInvoiceUrl: url().nullable(),
});

const usagePackMigrationRevisionPreviewResponseSchema =
  usagePackMigrationPreviewResponseSchema.extend({
    previewToken: string().min(1),
  });

const usagePackMigrationRevisionConfirmRequestSchema =
  usagePackMigrationPreviewRequestSchema.extend({
    previewToken: string().min(1),
  });

export type UsagePackMigrationStateResponse = zInfer<
  typeof usagePackMigrationStateResponseSchema
>;
export type UsagePackMigrationPreviewResponse = zInfer<
  typeof usagePackMigrationPreviewResponseSchema
>;
export type UsagePackMigrationConfirmResponse = zInfer<
  typeof usagePackMigrationConfirmResponseSchema
>;
export type UsagePackMigrationRevisionPreviewResponse = zInfer<
  typeof usagePackMigrationRevisionPreviewResponseSchema
>;

const checkoutCompleteRequestSchema = object({
  sessionId: string().min(1),
});

const concurrencyCheckoutRequestSchema = object({
  quantity: number().int().min(1).max(1000),
  paymentMethodPreviewToken: string().min(1).optional(),
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
});

const concurrencyCheckoutPreviewRequestSchema = object({
  quantity: number().int().min(1).max(1000),
  supportsInAppPreview: boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const concurrencySubscriptionChangeRequestSchema = object({
  quantity: number().int().min(1).max(1000),
  paymentMethodPreviewToken: string().min(1).optional(),
});

const concurrencySubscriptionChangePreviewRequestSchema = object({
  quantity: number().int().min(1).max(1000),
  supportsInAppPreview: boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const concurrencySubscriptionChangePreviewResponseSchema = object({
  currentQuantity: number().int().min(0).max(1000),
  targetQuantity: number().int().min(1).max(1000),
  immediateAmountCents: number().int().nonnegative(),
  nextRecurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  effectiveAt: iso.datetime().optional(),
  paymentMethodPreviewToken: string().min(1).optional(),
  checkoutUrl: url().optional(),
});

const concurrencySubscriptionChangeResponseSchema = discriminatedUnion(
  "status",
  [
    object({
      status: literal("processing"),
      hostedInvoiceUrl: zNull(),
      effectiveAt: iso.datetime().optional(),
    }),
    object({
      status: literal("pending_payment"),
      hostedInvoiceUrl: url(),
      effectiveAt: iso.datetime().optional(),
    }),
    object({
      status: literal("completed"),
      hostedInvoiceUrl: zNull(),
      effectiveAt: iso.datetime().optional(),
    }),
    object({
      status: literal("checkout_required"),
      checkoutUrl: url(),
    }),
  ],
);

const concurrencySubscriptionCancelResponseSchema = object({
  success: literal(true),
  currentPeriodEnd: string().nullable(),
});

const concurrencySubscriptionRestoreResponseSchema = object({
  success: literal(true),
});

const creditCheckoutRequestSchema = object({
  credits: number().int().min(1000).max(10_000_000),
  customAmount: boolean().optional(),
  previewExistingBilling: boolean().optional(),
  supportsInAppPreview: boolean().optional(),
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
  autoRecharge: object({
    enabled: boolean(),
    threshold: number().int().positive().max(10_000_000).optional(),
    amount: number().int().min(1000).max(10_000_000).optional(),
  }).optional(),
})
  .refine(
    (data) => {
      return data.customAmount !== true || data.autoRecharge === undefined;
    },
    { message: "auto-recharge is not supported for custom amount checkout" },
  )
  .refine(
    (data) => {
      return (
        data.autoRecharge?.enabled !== true ||
        data.autoRecharge.threshold === undefined ||
        data.autoRecharge.amount === undefined ||
        data.autoRecharge.threshold < data.autoRecharge.amount
      );
    },
    { message: "threshold must be less than amount to avoid recharge loops" },
  );

const portalRequestSchema = object({
  returnUrl: stripeRedirectUrlSchema,
});

const creditPurchasePreviewResponseSchema = object({
  status: literal("preview"),
  credits: number().int().positive(),
  amountCents: number().int().nonnegative(),
  currency: string().length(3),
  expiresAt: iso.datetime(),
  previewToken: string().min(1),
});

const creditPurchaseStartResponseSchema = union([
  checkoutResponseSchema,
  creditPurchasePreviewResponseSchema,
]);

const creditPurchaseConfirmResponseSchema =
  billingPurchaseConfirmResponseSchema;

const autoRechargeUpdateRequestSchema = object({
  enabled: boolean(),
  threshold: number().int().positive().max(10_000_000).optional(),
  amount: number().int().min(1000).max(10_000_000).optional(),
}).refine(
  (data) => {
    return (
      !data.enabled ||
      data.threshold === undefined ||
      data.amount === undefined ||
      data.threshold < data.amount
    );
  },
  { message: "threshold must be less than amount to avoid recharge loops" },
);

const redeemRequestSchema = object({
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
});

const redeemCodeRequestSchema = object({
  code: string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Contract for GET /api/billing/status
 */
export const billingStatusContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/status",
    headers: authHeadersSchema,
    responses: {
      200: billingStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get billing status for current org",
  },
});

export type BillingStatusContract = typeof billingStatusContract;

/**
 * Contract for POST /api/billing/checkout
 */
export const billingCheckoutContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/checkout",
    headers: authHeadersSchema,
    body: checkoutRequestSchema,
    responses: {
      200: union([
        checkoutResponseSchema,
        planPurchasePreviewResponseSchema,
        billingPurchaseConfirmResponseSchema,
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe checkout session",
  },
  confirm: {
    method: "POST",
    path: "/api/billing/checkout/confirm",
    headers: authHeadersSchema,
    body: object({ previewToken: string().min(1) }),
    responses: {
      200: billingPurchaseConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a previewed Plan subscription purchase",
  },
  complete: {
    method: "POST",
    path: "/api/billing/checkout/complete",
    headers: authHeadersSchema,
    body: checkoutCompleteRequestSchema,
    responses: {
      200: checkoutCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete Stripe checkout session",
  },
});

export type BillingCheckoutContract = typeof billingCheckoutContract;

/**
 * Contract for POST /api/billing/usage-pack-checkout
 */
export const billingUsagePackCheckoutContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/usage-pack-checkout",
    headers: authHeadersSchema,
    body: usagePackCheckoutRequestSchema,
    responses: {
      200: union([
        checkoutResponseSchema,
        usagePackPurchasePreviewResponseSchema,
        billingPurchaseConfirmResponseSchema,
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe checkout session for a plan with usage packs",
  },
  confirm: {
    method: "POST",
    path: "/api/billing/usage-pack-checkout/confirm",
    headers: authHeadersSchema,
    body: object({ previewToken: string().min(1) }),
    responses: {
      200: billingPurchaseConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a previewed usage pack subscription purchase",
  },
});

export type BillingUsagePackCheckoutContract =
  typeof billingUsagePackCheckoutContract;

export const billingUsagePackCatalogContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/usage-pack-catalog",
    headers: authHeadersSchema,
    responses: {
      200: usagePackCatalogResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get the validated Stripe usage pack catalog",
  },
});

export type BillingUsagePackCatalogContract =
  typeof billingUsagePackCatalogContract;

export const billingUsagePackManagementContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/usage-pack-subscription",
    headers: authHeadersSchema,
    responses: {
      200: usagePackManagementResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get current member usage pack allocations",
  },
  previewChange: {
    method: "POST",
    path: "/api/billing/usage-pack-subscription/changes/preview",
    headers: authHeadersSchema,
    body: usagePackChangePreviewRequestSchema,
    responses: {
      200: usagePackChangePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview a member usage pack change",
  },
  confirmChange: {
    method: "POST",
    path: "/api/billing/usage-pack-subscription/changes/:changeId/confirm",
    pathParams: object({ changeId: uuid() }),
    headers: authHeadersSchema,
    body: object({
      paymentMethodPreviewToken: string().min(1).optional(),
    }),
    responses: {
      200: usagePackChangeConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a previewed member usage pack change",
  },
  previewSubscriptionChange: {
    method: "POST",
    path: "/api/billing/usage-pack-subscription/subscription-change/preview",
    headers: authHeadersSchema,
    body: usagePackSubscriptionChangePreviewRequestSchema,
    responses: {
      200: usagePackSubscriptionChangePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview an existing usage pack subscription change",
  },
  confirmSubscriptionChange: {
    method: "POST",
    path: "/api/billing/usage-pack-subscription/subscription-change/confirm",
    headers: authHeadersSchema,
    body: usagePackSubscriptionChangeConfirmRequestSchema,
    responses: {
      200: usagePackChangeConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Apply an existing usage pack subscription change in place",
  },
});

export type BillingUsagePackManagementContract =
  typeof billingUsagePackManagementContract;

export const billingUsagePackCreditsContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/usage-pack-credits",
    headers: authHeadersSchema,
    responses: {
      200: usagePackCreditsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get spendable usage pack credits, including member balances for admins",
  },
});

export type BillingUsagePackCreditsContract =
  typeof billingUsagePackCreditsContract;
export type UsagePackCreditsResponse = zInfer<
  typeof usagePackCreditsResponseSchema
>;

export const billingUsagePackMigrationContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/usage-pack-migration",
    headers: authHeadersSchema,
    responses: {
      200: usagePackMigrationStateResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get legacy subscription usage pack migration state",
  },
  preview: {
    method: "POST",
    path: "/api/billing/usage-pack-migration/preview",
    headers: authHeadersSchema,
    body: usagePackMigrationPreviewRequestSchema,
    responses: {
      200: usagePackMigrationPreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview a legacy subscription usage pack migration",
  },
  confirm: {
    method: "POST",
    path: "/api/billing/usage-pack-migration/:migrationId/confirm",
    pathParams: object({ migrationId: uuid() }),
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: usagePackMigrationConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a legacy subscription usage pack migration",
  },
  previewRevision: {
    method: "POST",
    path: "/api/billing/usage-pack-migration/:migrationId/revision/preview",
    pathParams: object({ migrationId: uuid() }),
    headers: authHeadersSchema,
    body: usagePackMigrationPreviewRequestSchema,
    responses: {
      200: usagePackMigrationRevisionPreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview a scheduled legacy subscription migration revision",
  },
  confirmRevision: {
    method: "POST",
    path: "/api/billing/usage-pack-migration/:migrationId/revision/confirm",
    pathParams: object({ migrationId: uuid() }),
    headers: authHeadersSchema,
    body: usagePackMigrationRevisionConfirmRequestSchema,
    responses: {
      200: usagePackMigrationConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a scheduled legacy subscription migration revision",
  },
});

export type BillingUsagePackMigrationContract =
  typeof billingUsagePackMigrationContract;

/**
 * Contract for POST /api/billing/concurrency-checkout
 */
export const billingConcurrencyCheckoutContract = c.router({
  preview: {
    method: "POST",
    path: "/api/billing/concurrency-checkout/preview",
    headers: authHeadersSchema,
    body: concurrencyCheckoutPreviewRequestSchema,
    responses: {
      200: concurrencySubscriptionChangePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview a Stripe purchase for concurrency add-on slots",
  },
  create: {
    method: "POST",
    path: "/api/billing/concurrency-checkout",
    headers: authHeadersSchema,
    body: concurrencyCheckoutRequestSchema,
    responses: {
      200: checkoutResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start a Stripe purchase for concurrency add-on slots",
  },
});

export type BillingConcurrencyCheckoutContract =
  typeof billingConcurrencyCheckoutContract;

/**
 * Contract for concurrency subscriptions.
 */
export const billingConcurrencySubscriptionContract = c.router({
  previewChange: {
    method: "POST",
    path: "/api/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
    pathParams: object({
      subscriptionId: string().min(1),
    }),
    headers: authHeadersSchema,
    body: concurrencySubscriptionChangePreviewRequestSchema,
    responses: {
      200: concurrencySubscriptionChangePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Preview a concurrency add-on subscription quantity change",
  },
  confirmChange: {
    method: "POST",
    path: "/api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm",
    pathParams: object({
      subscriptionId: string().min(1),
    }),
    headers: authHeadersSchema,
    body: concurrencySubscriptionChangeRequestSchema,
    responses: {
      200: concurrencySubscriptionChangeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Apply a concurrency add-on subscription quantity change",
  },
  cancel: {
    method: "POST",
    path: "/api/billing/concurrency-subscriptions/:subscriptionId/cancel",
    pathParams: object({
      subscriptionId: string().min(1),
    }),
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: concurrencySubscriptionCancelResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Cancel a concurrency add-on subscription at period end",
  },
  restore: {
    method: "POST",
    path: "/api/billing/concurrency-subscriptions/:subscriptionId/restore",
    pathParams: object({
      subscriptionId: string().min(1),
    }),
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: concurrencySubscriptionRestoreResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Restore a concurrency add-on subscription",
  },
});

export type BillingConcurrencySubscriptionContract =
  typeof billingConcurrencySubscriptionContract;

/**
 * Contract for POST /api/billing/credit-checkout
 */
export const billingCreditCheckoutContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/credit-checkout",
    headers: authHeadersSchema,
    body: creditCheckoutRequestSchema,
    responses: {
      200: creditPurchaseStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start a credit purchase",
  },
  confirm: {
    method: "POST",
    path: "/api/billing/credit-checkout/confirm",
    headers: authHeadersSchema,
    body: object({ previewToken: string().min(1) }),
    responses: {
      200: creditPurchaseConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Confirm a previewed credit purchase",
  },
});

export type BillingCreditCheckoutContract =
  typeof billingCreditCheckoutContract;

/**
 * Contract for POST /api/billing/portal
 */
export const billingPortalContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/portal",
    headers: authHeadersSchema,
    body: portalRequestSchema,
    responses: {
      200: portalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe billing portal session",
  },
});

export type BillingPortalContract = typeof billingPortalContract;

/**
 * Contract for /api/billing/auto-recharge
 */
export const billingAutoRechargeContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/auto-recharge",
    headers: authHeadersSchema,
    responses: {
      200: autoRechargeSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get auto-recharge configuration",
  },
  update: {
    method: "PUT",
    path: "/api/billing/auto-recharge",
    headers: authHeadersSchema,
    body: autoRechargeUpdateRequestSchema,
    responses: {
      200: autoRechargeSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update auto-recharge configuration",
  },
});

export type BillingAutoRechargeContract = typeof billingAutoRechargeContract;

/**
 * Contract for GET /api/billing/invoices
 */
const invoiceSchema = object({
  id: string(),
  number: string().nullable(),
  date: number(),
  amount: number(),
  status: string().nullable(),
  hostedInvoiceUrl: string().nullable(),
});

const billingInvoicesResponseSchema = object({
  invoices: array(invoiceSchema),
});

export const billingInvoicesContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/invoices",
    headers: authHeadersSchema,
    responses: {
      200: billingInvoicesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get invoices for current org",
  },
});

export type BillingInvoicesContract = typeof billingInvoicesContract;

// ---------------------------------------------------------------------------
// Downgrade
// ---------------------------------------------------------------------------

const downgradeTargetTierSchema = zEnum(["limited-free-1", "pro"]);

const downgradeRequestSchema = object({
  targetTier: downgradeTargetTierSchema,
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const downgradeResponseSchema = union([
  object({
    success: boolean(),
    effectiveDate: string().nullable(),
  }),
  object({
    status: literal("payment_method_required"),
    checkoutUrl: url(),
  }),
]);

const restoreRequestSchema = object({
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const restoreResponseSchema = discriminatedUnion("status", [
  object({
    status: literal("restored"),
  }),
  object({
    status: literal("payment_method_required"),
    checkoutUrl: url(),
  }),
]);

/**
 * Contract for POST /api/billing/downgrade
 */
export const billingDowngradeContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/downgrade",
    headers: authHeadersSchema,
    body: downgradeRequestSchema,
    responses: {
      200: downgradeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Downgrade subscription to a lower tier",
  },
});

export type BillingDowngradeContract = typeof billingDowngradeContract;

/**
 * Contract for POST /api/billing/restore
 */
export const billingRestoreContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/restore",
    headers: authHeadersSchema,
    body: restoreRequestSchema,
    responses: {
      200: restoreResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Restore a subscription scheduled for cancellation",
  },
});

export type BillingRestoreContract = typeof billingRestoreContract;

/**
 * Contract for POST /api/billing/redeem/:campaign
 *
 * One-time campaign redemption. The handler validates the campaign whitelist,
 * creates (or resumes) a Stripe Checkout session, and returns a discriminated
 * union so a single landing page on the platform can render the appropriate
 * state (ready / already_granted / processing / error).
 */
export const billingRedeemContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/redeem/:campaign",
    pathParams: object({
      campaign: string(),
    }),
    headers: authHeadersSchema,
    body: redeemRequestSchema,
    responses: {
      200: redeemResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Redeem a one-time campaign",
  },
});

export type BillingRedeemContract = typeof billingRedeemContract;

/**
 * Contract for POST /api/billing/redeem-code
 *
 * Proxies onboarding invite codes to the Atom redeem endpoint. The platform
 * waits for billing status to update through realtime before completing
 * onboarding.
 */
export const billingRedeemCodeContract = c.router({
  create: {
    method: "POST",
    path: "/api/billing/redeem-code",
    headers: authHeadersSchema,
    body: redeemCodeRequestSchema,
    responses: {
      200: redeemCodeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Redeem an onboarding billing code",
  },
});

export type BillingRedeemCodeContract = typeof billingRedeemCodeContract;

// Inferred types from Zod schemas
export type BillingStatusResponse = zInfer<typeof billingStatusResponseSchema>;
export type AutoRechargeConfig = zInfer<typeof autoRechargeSchema>;
export type CheckoutResponse = zInfer<typeof checkoutResponseSchema>;
export type CheckoutRequest = zInfer<typeof checkoutRequestSchema>;
export type UsagePackCheckoutRequest = zInfer<
  typeof usagePackCheckoutRequestSchema
>;
export type PlanPurchasePreviewResponse = zInfer<
  typeof planPurchasePreviewResponseSchema
>;
export type UsagePackPurchasePreviewResponse = zInfer<
  typeof usagePackPurchasePreviewResponseSchema
>;
export type BillingPurchaseConfirmResponse = zInfer<
  typeof billingPurchaseConfirmResponseSchema
>;
export type RedeemCodeResponse = zInfer<typeof redeemCodeResponseSchema>;
export type ConcurrencyCheckoutRequest = zInfer<
  typeof concurrencyCheckoutRequestSchema
>;
export type ConcurrencySubscriptionChangePreviewResponse = zInfer<
  typeof concurrencySubscriptionChangePreviewResponseSchema
>;
export type ConcurrencySubscriptionChangeResponse = zInfer<
  typeof concurrencySubscriptionChangeResponseSchema
>;
export type CreditCheckoutRequest = zInfer<typeof creditCheckoutRequestSchema>;
export type CreditPurchasePreviewResponse = zInfer<
  typeof creditPurchasePreviewResponseSchema
>;
export type CreditPurchaseConfirmResponse = zInfer<
  typeof creditPurchaseConfirmResponseSchema
>;
export type PortalResponse = zInfer<typeof portalResponseSchema>;
export type BillingInvoice = zInfer<typeof invoiceSchema>;
export type BillingInvoicesResponse = zInfer<
  typeof billingInvoicesResponseSchema
>;
export type DowngradeResponse = zInfer<typeof downgradeResponseSchema>;
export type RestoreResponse = zInfer<typeof restoreResponseSchema>;
export type RedeemRequest = zInfer<typeof redeemRequestSchema>;
export type RedeemCodeRequest = zInfer<typeof redeemCodeRequestSchema>;
export type RedeemResponse = zInfer<typeof redeemResponseSchema>;
