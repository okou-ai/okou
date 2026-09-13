import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { adAttributionMetadataSchema } from "./acquisition-attribution";

const c = initContract();

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const autoRechargeSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().nullable(),
  amount: z.number().nullable(),
});

const creditExpirySchema = z.object({
  expiringNextCycle: z.number(),
  nextExpiryDate: z.string().nullable(),
});

const creditBreakdownSegmentSchema = z.object({
  category: z.enum(["plan", "free", "promotional", "payAsYouGo"]),
  label: z.string(),
  credits: z.number(),
  // Only set on `plan` segments. Lets the UI decide whether a segment
  // represents the current plan or leftover credits from a previous plan
  // without round-tripping through the `label` string.
  tier: z.enum(["pro", "team"]).optional(),
});

const creditGrantSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  amount: z.number(),
  remaining: z.number(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const scheduledBillingChangeSchema = z.object({
  type: z.enum(["cancel", "downgrade"]),
  targetTier: z
    .enum(["limited-free-1", "pro-suspend", "pro", "team"])
    .nullable(),
  effectiveDate: z.string().nullable(),
});

const concurrencySubscriptionSchema = z.object({
  id: z.string(),
  quantity: z.number().int().nonnegative(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canReduce: z.boolean().optional(),
  // Emitted for every subscription that is not cancelling, like `canReduce`.
  // It stays optional so a new app reaching a draining older API still parses
  // the response; no client branches on its absence since #26152.
  canChangeInApp: z.boolean().optional(),
  // Optional while older API deployments can still serve an already-loaded
  // web/app client during rollout.
  scheduledQuantity: z.number().int().positive().nullable().optional(),
  scheduledChangeAt: z.string().nullable().optional(),
});

const usageAllowanceWindowSchema = z.object({
  kind: z.enum(["short", "weekly"]),
  windowSeconds: z.number().int().positive(),
  unitLimit: z.number(),
  consumedUnits: z.number(),
  remainingUnits: z.number(),
  startsAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const usageAllowanceSchema = z.object({
  windows: z.array(usageAllowanceWindowSchema),
});

const billingStatusResponseSchema = z.object({
  tier: z.string(),
  // Existing entitlement state; optional while older API targets can serve.
  status: z.enum(["active", "suspended"]).optional(),
  canBuyConcurrency: z.boolean().optional(),
  // The current API omits the amount when the configured Stripe Price is
  // unavailable.
  concurrencyUnitAmountCents: z.number().int().positive().optional(),
  concurrencyPurchaseReviewAvailable: z.boolean().optional(),
  canBuyCredits: z.boolean().optional(),
  showUsagePack: z.boolean(),
  // Outgoing Apps still consume this derived status alias. Current Apps ignore
  // it; there is no independent invitation capability. Cleanup: #32575.
  memberInvitationAllowed: z.boolean().optional(),
  autoRechargeAllowed: z.boolean().optional(),
  supportByok: z.boolean().optional(),
  restrictedBuiltInModels: z.boolean().optional(),
  // Retired brand alias of restrictedBuiltInModels, sent with an identical
  // value from the same source while Apps older than this release are still
  // installed. Remove once they are below the rollback floor: #33658 step 2.
  restrictedVm0Models: z.boolean().optional(),
  videoGenerationAllowed: z.boolean().optional(),
  workflowWebhookAutomationAllowed: z.boolean().optional(),
  credits: z.number(),
  onboardingPaymentPending: z.boolean(),
  subscriptionStatus: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  scheduledChange: scheduledBillingChangeSchema.nullable(),
  // Optional while older API deployments can still serve an already-loaded
  // web/app client during rollout.
  canRestorePlan: z.boolean().optional(),
  hasSubscription: z.boolean(),
  autoRecharge: autoRechargeSchema,
  creditExpiry: creditExpirySchema,
  creditBreakdown: z.array(creditBreakdownSegmentSchema),
  creditGrants: z.array(creditGrantSchema),
  concurrencyLimit: z.number().int().nonnegative(),
  concurrencySubscriptions: z.array(concurrencySubscriptionSchema),
  usageAllowance: usageAllowanceSchema.nullable().optional(),
});

const checkoutResponseSchema = z.object({
  url: z.string(),
});

const subscriptionPurchasePreviewBaseSchema = z.object({
  status: z.literal("preview"),
  tier: z.enum(["pro", "team"]),
  immediateAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  expiresAt: z.iso.datetime(),
  previewToken: z.string().min(1),
});

const planPurchasePreviewResponseSchema =
  subscriptionPurchasePreviewBaseSchema.extend({
    purchaseType: z.literal("plan"),
    trialDays: z.literal(7).optional(),
  });

const usagePackPurchasePreviewResponseSchema =
  subscriptionPurchasePreviewBaseSchema.extend({
    purchaseType: z.literal("usage_pack"),
  });

const googleAdsPaidConversionSchema = z.object({
  googleAdsAccountId: z.string().optional(),
  transactionId: z.string().min(1),
  valueUsd: z.number().positive(),
});

const billingPurchaseConfirmResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    hostedInvoiceUrl: z.null(),
    googleAdsConversion: googleAdsPaidConversionSchema.optional(),
  }),
  z.object({
    status: z.literal("pending_payment"),
    hostedInvoiceUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("checkout_required"),
    checkoutUrl: z.string().url(),
  }),
]);

const checkoutCompleteResponseSchema = z.object({
  completed: z.boolean(),
  googleAdsConversion: googleAdsPaidConversionSchema.optional(),
});

const redeemCodeResponseSchema = z.object({
  redeemed: z.literal(true),
});

const portalResponseSchema = z.object({
  url: z.string(),
});

const redeemResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    checkoutUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("already_granted"),
  }),
  z.object({
    status: z.literal("processing"),
  }),
  z.object({
    status: z.literal("error"),
    reason: z.enum([
      "campaign_misconfigured",
      "admin_required",
      "billing_unavailable",
    ]),
  }),
]);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const stripeRedirectUrlSchema = z.string().url().max(5000);

const checkoutRequestSchema = z.object({
  tier: z.enum(["pro", "team"]),
  supportsInAppPreview: z.boolean().optional(),
  previewToken: z.string().min(1).optional(),
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
  trialDays: z.literal(7).optional(),
  adAttribution: adAttributionMetadataSchema.optional(),
});

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;
export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];

export const usagePackUsdSchema: z.ZodType<UsagePackUsd> = z.union([
  z.literal(20),
  z.literal(50),
  z.literal(100),
  z.literal(200),
]);

const usagePackCatalogItemSchema = z.object({
  usagePackUsd: usagePackUsdSchema,
  priceUsd: z.number().positive(),
  purchasedCredits: z.number().int().positive(),
  bonusCredits: z.number().int().positive(),
  totalCredits: z.number().int().positive(),
});

const usagePackCatalogResponseSchema = z.object({
  usagePacks: z.array(usagePackCatalogItemSchema),
  supportsFreeMembers: z.boolean().optional(),
});

const usagePackCreditBalanceSchema = z.object({
  totalCredits: z.number().int().nonnegative(),
  purchasedCredits: z.number().int().nonnegative(),
  bonusCredits: z.number().int().nonnegative(),
  creditGrants: z.array(
    z.object({
      id: z.string(),
      grantType: z.enum(["purchased", "bonus"]),
      amount: z.number().int().positive(),
      remaining: z.number().int().positive(),
      createdAt: z.string(),
      expiresAt: z.string(),
    }),
  ),
});

const usagePackCreditsResponseSchema = usagePackCreditBalanceSchema.extend({
  hasUsagePack: z.boolean().optional(),
  memberCredits: z
    .array(
      usagePackCreditBalanceSchema.extend({
        memberId: z.string().min(1),
      }),
    )
    .optional(),
});

const memberUsagePackSchema = z.object({
  memberId: z.string().min(1),
  // Free members have no paid allocation or Stripe usage pack item.
  usagePackUsd: z.union([z.literal(0), usagePackUsdSchema]),
});
export type MemberUsagePack = z.infer<typeof memberUsagePackSchema>;
export type UsagePackCatalogItem = z.infer<typeof usagePackCatalogItemSchema>;

const usagePackCheckoutRequestSchema = z.object({
  tier: z.enum(["pro", "team"]),
  supportsInAppPreview: z.boolean().optional(),
  previewToken: z.string().min(1).optional(),
  memberUsagePacks: z.array(memberUsagePackSchema).min(1).max(1000),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  adAttribution: adAttributionMetadataSchema.optional(),
});

const usagePackChangeStatusSchema = z.enum([
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
]);

const usagePackPendingChangeSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["addition", "upgrade", "downgrade", "removal"]),
  status: usagePackChangeStatusSchema,
  targetUsagePackUsd: usagePackUsdSchema.nullable(),
  effectiveAt: z.iso.datetime().nullable(),
});

const managedUsagePackAllocationSchema = z.object({
  id: z.uuid(),
  memberId: z.string().min(1),
  usagePackUsd: usagePackUsdSchema,
  currentPeriodEnd: z.iso.datetime().nullable(),
  pendingChange: usagePackPendingChangeSchema.nullable(),
});

const usagePackManagementResponseSchema = z.object({
  tier: z.enum(["pro", "team"]),
  currentPeriodEnd: z.iso.datetime().nullable(),
  supportsMemberAdditions: z.boolean().optional(),
  supportsFreeMembers: z.boolean().optional(),
  allocations: z.array(managedUsagePackAllocationSchema),
});

const usagePackChangePreviewRequestSchema = z.object({
  memberId: z.string().min(1),
  targetUsagePackUsd: usagePackUsdSchema,
  supportsInAppPreview: z.boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const usagePackChangePreviewResponseSchema = z.object({
  changeId: z.uuid(),
  kind: z.enum(["upgrade", "downgrade"]),
  sourceUsagePackUsd: usagePackUsdSchema,
  targetUsagePackUsd: usagePackUsdSchema,
  immediateAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  effectiveAt: z.iso.datetime().nullable(),
  prorationDate: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  paymentMethodPreviewToken: z.string().min(1).optional(),
  checkoutUrl: z.string().url().optional(),
});

const usagePackChangeConfirmResponseSchema = z.union([
  z.object({
    status: z.enum(["processing", "pending_payment", "scheduled", "completed"]),
    effectiveAt: z.iso.datetime().nullable(),
    hostedInvoiceUrl: z.string().url().nullable(),
  }),
  z.object({
    status: z.literal("checkout_required"),
    checkoutUrl: z.string().url(),
  }),
]);

const usagePackSubscriptionChangePreviewRequestSchema = z.object({
  targetTier: z.enum(["pro", "team"]),
  memberUsagePacks: z.array(memberUsagePackSchema).min(1).max(1000),
  supportsInAppPreview: z.boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const usagePackSubscriptionChangePreviewResponseSchema = z.object({
  changeId: z.uuid(),
  sourceTier: z.enum(["pro", "team"]),
  targetTier: z.enum(["pro", "team"]),
  immediateAmountCents: z.number().int().nonnegative(),
  immediateCreditGrant: z
    .object({
      purchasedCredits: z.number().int().nonnegative(),
      bonusCredits: z.number().int().nonnegative(),
      totalCredits: z.number().int().nonnegative(),
      expiresAt: z.iso.datetime().optional(),
    })
    .optional(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  effectiveAt: z.iso.datetime(),
  prorationDate: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  paymentMethodPreviewToken: z.string().min(1).optional(),
  checkoutUrl: z.string().url().optional(),
});

const usagePackSubscriptionChangeConfirmRequestSchema = z.object({
  changeId: z.uuid(),
  paymentMethodPreviewToken: z.string().min(1).optional(),
});

export type UsagePackManagementResponse = z.infer<
  typeof usagePackManagementResponseSchema
>;
export type UsagePackChangePreviewResponse = z.infer<
  typeof usagePackChangePreviewResponseSchema
>;
export type UsagePackChangeConfirmResponse = z.infer<
  typeof usagePackChangeConfirmResponseSchema
>;
export type UsagePackSubscriptionChangePreviewResponse = z.infer<
  typeof usagePackSubscriptionChangePreviewResponseSchema
>;

export const usagePackMigrationConfigurationSchema = z.object({
  tier: z.enum(["pro", "team"]),
  memberUsagePacks: z.array(memberUsagePackSchema).max(1000),
  recurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export type UsagePackMigrationConfiguration = z.infer<
  typeof usagePackMigrationConfigurationSchema
>;

const usagePackMigrationStateResponseSchema = z.object({
  tier: z.enum(["pro", "team"]),
  targetTier: z.enum(["pro", "team"]).nullable(),
  status: z.enum(["eligible", "previewed", "applying", "scheduled"]),
  migrationId: z.uuid().nullable(),
  effectiveAt: z.iso.datetime().nullable(),
  hostedInvoiceUrl: z.string().url().nullable(),
  configuration: usagePackMigrationConfigurationSchema.optional(),
});

const usagePackMigrationPreviewRequestSchema = z.object({
  targetTier: z.enum(["pro", "team"]),
  memberUsagePacks: z.array(memberUsagePackSchema).min(1).max(1000),
});

const usagePackMigrationPreviewResponseSchema = z.object({
  migrationId: z.uuid(),
  tier: z.enum(["pro", "team"]),
  targetTier: z.enum(["pro", "team"]),
  currentRecurringAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  recurringDifferenceCents: z.number().int(),
  currency: z.string().length(3),
  purchasedCredits: z.number().int().nonnegative(),
  bonusCredits: z.number().int().nonnegative(),
  totalCredits: z.number().int().nonnegative(),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

const usagePackMigrationConfirmResponseSchema = z.object({
  status: z.enum(["scheduled", "completed"]),
  effectiveAt: z.iso.datetime(),
  hostedInvoiceUrl: z.string().url().nullable(),
});

const usagePackMigrationRevisionPreviewResponseSchema =
  usagePackMigrationPreviewResponseSchema.extend({
    previewToken: z.string().min(1),
  });

const usagePackMigrationRevisionConfirmRequestSchema =
  usagePackMigrationPreviewRequestSchema.extend({
    previewToken: z.string().min(1),
  });

export type UsagePackMigrationStateResponse = z.infer<
  typeof usagePackMigrationStateResponseSchema
>;
export type UsagePackMigrationPreviewResponse = z.infer<
  typeof usagePackMigrationPreviewResponseSchema
>;
export type UsagePackMigrationConfirmResponse = z.infer<
  typeof usagePackMigrationConfirmResponseSchema
>;
export type UsagePackMigrationRevisionPreviewResponse = z.infer<
  typeof usagePackMigrationRevisionPreviewResponseSchema
>;

const checkoutCompleteRequestSchema = z.object({
  sessionId: z.string().min(1),
});

const concurrencyCheckoutRequestSchema = z.object({
  quantity: z.number().int().min(1).max(1000),
  paymentMethodPreviewToken: z.string().min(1).optional(),
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
});

const concurrencyCheckoutPreviewRequestSchema = z.object({
  quantity: z.number().int().min(1).max(1000),
  supportsInAppPreview: z.boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const concurrencySubscriptionChangeRequestSchema = z.object({
  quantity: z.number().int().min(1).max(1000),
  paymentMethodPreviewToken: z.string().min(1).optional(),
});

const concurrencySubscriptionChangePreviewRequestSchema = z.object({
  quantity: z.number().int().min(1).max(1000),
  supportsInAppPreview: z.boolean().optional(),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const concurrencySubscriptionChangePreviewResponseSchema = z.object({
  currentQuantity: z.number().int().min(0).max(1000),
  targetQuantity: z.number().int().min(1).max(1000),
  immediateAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  effectiveAt: z.iso.datetime().optional(),
  paymentMethodPreviewToken: z.string().min(1).optional(),
  checkoutUrl: z.string().url().optional(),
});

const concurrencySubscriptionChangeResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("processing"),
      hostedInvoiceUrl: z.null(),
      effectiveAt: z.iso.datetime().optional(),
    }),
    z.object({
      status: z.literal("pending_payment"),
      hostedInvoiceUrl: z.string().url(),
      effectiveAt: z.iso.datetime().optional(),
    }),
    z.object({
      status: z.literal("completed"),
      hostedInvoiceUrl: z.null(),
      effectiveAt: z.iso.datetime().optional(),
    }),
    z.object({
      status: z.literal("checkout_required"),
      checkoutUrl: z.string().url(),
    }),
  ],
);

const concurrencySubscriptionCancelResponseSchema = z.object({
  success: z.literal(true),
  currentPeriodEnd: z.string().nullable(),
});

const concurrencySubscriptionRestoreResponseSchema = z.object({
  success: z.literal(true),
});

const creditCheckoutRequestSchema = z
  .object({
    credits: z.number().int().min(1000).max(10_000_000),
    customAmount: z.boolean().optional(),
    previewExistingBilling: z.boolean().optional(),
    supportsInAppPreview: z.boolean().optional(),
    successUrl: stripeRedirectUrlSchema,
    cancelUrl: stripeRedirectUrlSchema,
    autoRecharge: z
      .object({
        enabled: z.boolean(),
        threshold: z.number().int().positive().max(10_000_000).optional(),
        amount: z.number().int().min(1000).max(10_000_000).optional(),
      })
      .optional(),
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

const portalRequestSchema = z.object({
  returnUrl: stripeRedirectUrlSchema,
});

const creditPurchasePreviewResponseSchema = z.object({
  status: z.literal("preview"),
  credits: z.number().int().positive(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  expiresAt: z.iso.datetime(),
  previewToken: z.string().min(1),
});

const creditPurchaseStartResponseSchema = z.union([
  checkoutResponseSchema,
  creditPurchasePreviewResponseSchema,
]);

const creditPurchaseConfirmResponseSchema =
  billingPurchaseConfirmResponseSchema;

const autoRechargeUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().int().positive().max(10_000_000).optional(),
    amount: z.number().int().min(1000).max(10_000_000).optional(),
  })
  .refine(
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

const redeemRequestSchema = z.object({
  successUrl: stripeRedirectUrlSchema,
  cancelUrl: stripeRedirectUrlSchema,
});

const redeemCodeRequestSchema = z.object({
  code: z.string().trim().min(1),
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
      200: z.union([
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
    body: z.object({ previewToken: z.string().min(1) }),
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
      200: z.union([
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
    body: z.object({ previewToken: z.string().min(1) }),
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
    pathParams: z.object({ changeId: z.uuid() }),
    headers: authHeadersSchema,
    body: z.object({
      paymentMethodPreviewToken: z.string().min(1).optional(),
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
export type UsagePackCreditsResponse = z.infer<
  typeof usagePackCreditsResponseSchema
>;

export const billingUsagePackMigrationContract = c.router({
  get: {
    method: "GET",
    path: "/api/billing/usage-pack-migration",
    headers: authHeadersSchema,
    query: z
      .object({ supportsFreeMembers: z.literal("true").optional() })
      .optional(),
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
    pathParams: z.object({ migrationId: z.uuid() }),
    headers: authHeadersSchema,
    body: z.object({}),
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
    pathParams: z.object({ migrationId: z.uuid() }),
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
    pathParams: z.object({ migrationId: z.uuid() }),
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
    pathParams: z.object({
      subscriptionId: z.string().min(1),
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
    pathParams: z.object({
      subscriptionId: z.string().min(1),
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
    pathParams: z.object({
      subscriptionId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: z.object({}),
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
    pathParams: z.object({
      subscriptionId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: z.object({}),
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
    body: z.object({ previewToken: z.string().min(1) }),
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
const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  date: z.number(),
  amount: z.number(),
  status: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
});

const billingInvoicesResponseSchema = z.object({
  invoices: z.array(invoiceSchema),
  // Optional while the frontend can overlap with API deployments that do not expose ZIP downloads yet.
  receiptDownloadsSupported: z.literal(true).optional(),
});

const billingReceiptsMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);

function billingMonthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

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
  downloadReceipts: {
    method: "GET",
    path: "/api/billing/invoices/receipts",
    headers: authHeadersSchema,
    query: z
      .object({
        startMonth: billingReceiptsMonthSchema,
        endMonth: billingReceiptsMonthSchema,
      })
      .refine((query) => {
        return query.startMonth <= query.endMonth;
      }, "startMonth must not be after endMonth")
      .refine((query) => {
        return (
          billingMonthIndex(query.endMonth) -
            billingMonthIndex(query.startMonth) <
          3
        );
      }, "Receipt downloads are limited to three consecutive months"),
    responses: {
      200: c.otherResponse({
        contentType: "application/zip",
        body: c.type<Blob>(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download monthly receipts for current org",
  },
});

export type BillingInvoicesContract = typeof billingInvoicesContract;

// ---------------------------------------------------------------------------
// Downgrade
// ---------------------------------------------------------------------------

const downgradeRequestSchema = z.object({
  targetTier: z.enum(["limited-free-1", "pro-suspend", "pro"]),
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const downgradeResponseSchema = z.union([
  z.object({
    success: z.boolean(),
    effectiveDate: z.string().nullable(),
  }),
  z.object({
    status: z.literal("payment_method_required"),
    checkoutUrl: z.string().url(),
  }),
]);

const restoreRequestSchema = z.object({
  returnUrl: stripeRedirectUrlSchema.optional(),
});

const restoreResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("restored"),
  }),
  z.object({
    status: z.literal("payment_method_required"),
    checkoutUrl: z.string().url(),
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
    pathParams: z.object({
      campaign: z.string(),
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
export type BillingStatusResponse = z.infer<typeof billingStatusResponseSchema>;
export type AutoRechargeConfig = z.infer<typeof autoRechargeSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export type UsagePackCheckoutRequest = z.infer<
  typeof usagePackCheckoutRequestSchema
>;
export type PlanPurchasePreviewResponse = z.infer<
  typeof planPurchasePreviewResponseSchema
>;
export type UsagePackPurchasePreviewResponse = z.infer<
  typeof usagePackPurchasePreviewResponseSchema
>;
export type BillingPurchaseConfirmResponse = z.infer<
  typeof billingPurchaseConfirmResponseSchema
>;
export type GoogleAdsPaidConversion = z.infer<
  typeof googleAdsPaidConversionSchema
>;
export type RedeemCodeResponse = z.infer<typeof redeemCodeResponseSchema>;
export type ConcurrencyCheckoutRequest = z.infer<
  typeof concurrencyCheckoutRequestSchema
>;
export type ConcurrencySubscriptionChangePreviewResponse = z.infer<
  typeof concurrencySubscriptionChangePreviewResponseSchema
>;
export type ConcurrencySubscriptionChangeResponse = z.infer<
  typeof concurrencySubscriptionChangeResponseSchema
>;
export type CreditCheckoutRequest = z.infer<typeof creditCheckoutRequestSchema>;
export type CreditPurchasePreviewResponse = z.infer<
  typeof creditPurchasePreviewResponseSchema
>;
export type CreditPurchaseConfirmResponse = z.infer<
  typeof creditPurchaseConfirmResponseSchema
>;
export type PortalResponse = z.infer<typeof portalResponseSchema>;
export type BillingInvoice = z.infer<typeof invoiceSchema>;
export type BillingInvoicesResponse = z.infer<
  typeof billingInvoicesResponseSchema
>;
export type DowngradeResponse = z.infer<typeof downgradeResponseSchema>;
export type RestoreResponse = z.infer<typeof restoreResponseSchema>;
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;
export type RedeemCodeRequest = z.infer<typeof redeemCodeRequestSchema>;
export type RedeemResponse = z.infer<typeof redeemResponseSchema>;
