import {
  googleAdsAccountForAttribution,
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";
import { command } from "ccstate";
import {
  billingCheckoutContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  type MemberUsagePack,
  type UsagePackCatalogItem,
  type UsagePackSubscriptionChangePreviewResponse,
} from "@okouai/api-contracts/contracts/billing";
import { adAttributionMetadataSchema } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { clerkAttributionDisabled } from "../../lib/clerk-attribution";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { impactStripeMetadata$ } from "../services/impact-attribution.service";
import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { requestSignal$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  clerk$,
  createClerkReadContext,
  type ClerkClient,
} from "../external/clerk";
import { db$, writeDb$, type Db } from "../external/db";
import { getStripeClient, type StripeInvoice } from "../external/stripe-client";
import {
  activePriceId,
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  completeCheckoutSession$,
  confirmPlanPurchase$,
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  startPlanPurchase$,
  type SubscriptionCheckoutTier,
} from "../services/billing-checkout.service";
import {
  confirmUsagePackPurchase$,
  activeUsagePackBillingContext,
  loadUsagePackCatalog,
  startUsagePackPurchase$,
  usagePackPurchaseSerializationSchemaAvailable,
  usagePackSubscriptionSchemaAvailable,
  type UsagePackCheckoutAllocation,
} from "../services/usage-pack-subscription.service";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import {
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import {
  confirmUsagePackAllocationChange,
  getUsagePackManagement,
  previewUsagePackAllocationChange,
  usagePackAllocationChangeSchemaAvailable,
} from "../services/usage-pack-allocation-change.service";
import {
  confirmUsagePackSubscriptionChange,
  previewUsagePackSubscriptionChange,
  usagePackMemberAdditionSchemaAvailable,
  usagePackSubscriptionChangeSchemaAvailable,
} from "../services/usage-pack-plan-change.service";
import {
  confirmUsagePackSubscriptionMigration,
  confirmUsagePackSubscriptionMigrationRevision,
  getUsagePackMigrationState,
  previewUsagePackSubscriptionMigration,
  previewUsagePackSubscriptionMigrationRevision,
  type UsagePackMigrationOwner,
} from "../services/usage-pack-subscription-migration.service";
import { usagePackInvitationPurchaseSchemaAvailable } from "../services/usage-pack-invitation-purchase.service";
import {
  loadBillingOrganizationDirectory,
  loadBillingOrganizationMemberships,
} from "../services/billing-clerk-directory.service";
import { reconcilePaidStripeInvoice$ } from "../services/webhooks-stripe.service";
import {
  mergeFirstTouchAttribution,
  parseStoredSignupAttribution,
} from "../services/acquisition-attribution.service";
import type { RouteEntry } from "../route-entry";
import { withBillingClerkRateLimit } from "./billing-clerk-rate-limit";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    }),
  }),
});

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";
const USAGE_PACK_PLAN_ENDING_MESSAGE =
  "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.";
const log = logger("api:billing-checkout");

type UsagePackSubscriptionChangePreviewResult = Awaited<
  ReturnType<typeof previewUsagePackSubscriptionChange>
>;
type UsagePackSubscriptionChangeConfirmResult = Awaited<
  ReturnType<typeof confirmUsagePackSubscriptionChange>
>;
type UsagePackSubscriptionChangeResult =
  | UsagePackSubscriptionChangePreviewResult
  | UsagePackSubscriptionChangeConfirmResult;
type UsagePackSubscriptionChangeConflictResult = Extract<
  UsagePackSubscriptionChangeResult,
  { readonly status: "plan_ending" | "conflict" }
>;
const USAGE_PACK_SUBSCRIPTION_CHANGE_CONFLICT_MESSAGES = {
  plan_ending: USAGE_PACK_PLAN_ENDING_MESSAGE,
  conflict: "Another usage pack billing change is in progress",
} satisfies Readonly<
  Record<UsagePackSubscriptionChangeConflictResult["status"], string>
>;

function isUsagePackSubscriptionChangeConflict(
  result: UsagePackSubscriptionChangeResult,
): result is UsagePackSubscriptionChangeConflictResult {
  return result.status === "plan_ending" || result.status === "conflict";
}

async function signupAttributionForUser(
  clerk: ClerkClient,
  userId: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof adAttributionMetadataSchema.parse> | undefined> {
  const usersResult = await settle(
    Promise.resolve(
      clerk.users.getUserList(
        {
          userId: [userId],
          limit: 1,
        },
        undefined,
        signal,
      ),
    ),
    signal,
  );
  if (!usersResult.ok) {
    log.warn("Unable to read Clerk signup attribution for checkout", {
      userId,
      error: usersResult.error,
    });
    return undefined;
  }

  const user = usersResult.value?.data?.find((candidate) => {
    return candidate.id === userId;
  });
  return user
    ? parseStoredSignupAttribution(
        user.privateMetadata?.[SIGNUP_ATTRIBUTION_KEY],
      )
    : undefined;
}

async function checkoutAttribution(
  clerk: ClerkClient,
  userId: string,
  adAttribution: Parameters<typeof mergeFirstTouchAttribution>[0],
  signal: AbortSignal,
): Promise<ReturnType<typeof mergeFirstTouchAttribution>> {
  if (clerkAttributionDisabled()) {
    return undefined;
  }
  const storedAttribution = await signupAttributionForUser(
    clerk,
    userId,
    signal,
  );
  return mergeFirstTouchAttribution(adAttribution, storedAttribution);
}

function memberUsagePackIdsMatch(
  selections: readonly MemberUsagePack[],
  expectedMemberIds: readonly string[],
): boolean {
  const selectedMemberIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  return (
    selectedMemberIds.size === selections.length &&
    selectedMemberIds.size === expectedMemberIds.length &&
    expectedMemberIds.every((memberId) => {
      return selectedMemberIds.has(memberId);
    })
  );
}

function checkoutRedirectsAllowed(
  successUrl: string,
  cancelUrl: string,
): boolean {
  return (
    billingRedirectAllowed(successUrl) && billingRedirectAllowed(cancelUrl)
  );
}

function billingPreviewReturnUrlAllowed(
  previewEnabled: boolean,
  returnUrl: string | undefined,
): boolean {
  return (
    !previewEnabled ||
    (returnUrl !== undefined && billingRedirectAllowed(returnUrl))
  );
}

function hasPaidUsagePack(
  memberUsagePacks: readonly MemberUsagePack[],
): boolean {
  return memberUsagePacks.some((selection) => {
    return selection.usagePackUsd !== 0;
  });
}

async function validateUsagePackSubscriptionMembers(
  args: {
    readonly clerk: ClerkClient;
    readonly orgId: string;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly allocatedMemberIds: readonly string[];
    readonly memberAdditionSchemaAvailable: boolean;
  },
  signal: AbortSignal,
): Promise<"valid" | "member_additions_unavailable" | "members_changed"> {
  const allocatedMemberIds = new Set(args.allocatedMemberIds);
  const addsMember = args.memberUsagePacks.some((selection) => {
    return !allocatedMemberIds.has(selection.memberId);
  });
  if (!addsMember) {
    return "valid";
  }
  if (!args.memberAdditionSchemaAvailable) {
    return "member_additions_unavailable";
  }
  const memberships = await loadBillingOrganizationMemberships(
    args.clerk,
    args.orgId,
    createClerkReadContext(),
    signal,
  );
  signal.throwIfAborted();
  const activeMemberIds = memberships.map((membership) => {
    const memberId = membership.publicUserData?.userId;
    if (!memberId) {
      throw new Error("Clerk organization membership is missing its user ID");
    }
    return memberId;
  });
  return memberUsagePackIdsMatch(args.memberUsagePacks, activeMemberIds)
    ? "valid"
    : "members_changed";
}

async function routeUsagePackSubscriptionChangePayment(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly preview: UsagePackSubscriptionChangePreviewResponse;
    readonly returnUrl: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "not_found" }
  | {
      readonly kind: "response";
      readonly body: UsagePackSubscriptionChangePreviewResponse;
    }
> {
  const billing = await activeUsagePackBillingContext(args.db, args.orgId);
  signal.throwIfAborted();
  if (!billing) {
    return { kind: "not_found" };
  }
  const route = await routeBillingPurchasePreview(
    {
      stripe: getStripeClient(),
      orgId: args.orgId,
      customerId: billing.stripeCustomerId,
      subscriptionId: billing.stripeSubscriptionId,
      operation: "usage_pack_subscription",
      operationId: args.preview.changeId,
      returnUrl: args.returnUrl,
    },
    signal,
  );
  return {
    kind: "response",
    body: {
      ...args.preview,
      ...(route.paymentMethodPreviewToken
        ? { paymentMethodPreviewToken: route.paymentMethodPreviewToken }
        : {}),
    },
  };
}

interface UsagePackMembership {
  readonly publicUserData?: { readonly userId?: string | null } | null;
}

interface UsagePackInvitation {
  readonly id: string;
}

interface UsagePackMigrationInvitation extends UsagePackInvitation {
  readonly emailAddress: string;
  readonly role: string;
}

function usagePackMigrationOwners(
  memberships: readonly UsagePackMembership[],
  invitations: readonly UsagePackMigrationInvitation[],
  inviterUserId: string,
): readonly UsagePackMigrationOwner[] {
  return [
    ...memberships.map((membership): UsagePackMigrationOwner => {
      const userId = membership.publicUserData?.userId;
      if (!userId) {
        throw new Error("Clerk organization membership is missing its user ID");
      }
      return { userId };
    }),
    ...invitations.map((invitation): UsagePackMigrationOwner => {
      return {
        invitationId: invitation.id,
        normalizedEmail: invitation.emailAddress.trim().toLowerCase(),
        role:
          invitation.role === "org:admin" || invitation.role === "admin"
            ? "admin"
            : "member",
        inviterUserId,
      };
    }),
  ];
}

function usagePackCheckoutAllocations(
  selections: readonly MemberUsagePack[],
  memberships: readonly UsagePackMembership[],
  invitations: readonly UsagePackInvitation[],
  catalog: readonly UsagePackCatalogItem[],
): readonly UsagePackCheckoutAllocation[] | null {
  const memberIds = memberships.map((membership) => {
    const memberId = membership.publicUserData?.userId;
    if (!memberId) {
      throw new Error("Clerk organization membership is missing its user ID");
    }
    return memberId;
  });
  const invitationIds = invitations.map((invitation) => {
    return invitation.id;
  });
  if (!memberUsagePackIdsMatch(selections, [...memberIds, ...invitationIds])) {
    return null;
  }

  const memberIdSet = new Set(memberIds);
  const invitationIdSet = new Set(invitationIds);
  const catalogSelections = new Set(
    catalog.map((item) => {
      return item.usagePackUsd;
    }),
  );
  return selections.flatMap(
    (selection): readonly UsagePackCheckoutAllocation[] => {
      if (selection.usagePackUsd === 0) {
        return [];
      }
      if (!catalogSelections.has(selection.usagePackUsd)) {
        throw new Error(
          `Usage pack $${selection.usagePackUsd} is missing from the catalog`,
        );
      }
      const stripePriceId = activeUsagePackPriceId(selection.usagePackUsd);
      if (!stripePriceId) {
        throw new Error(
          `Usage pack $${selection.usagePackUsd} Price is not configured`,
        );
      }
      if (memberIdSet.has(selection.memberId)) {
        return [
          {
            usagePackUsd: selection.usagePackUsd,
            stripePriceId,
            userId: selection.memberId,
          },
        ];
      }
      if (!invitationIdSet.has(selection.memberId)) {
        throw new Error(
          `Usage pack owner ${selection.memberId} is no longer eligible`,
        );
      }
      return [
        {
          usagePackUsd: selection.usagePackUsd,
          stripePriceId,
          invitationId: selection.memberId,
        },
      ];
    },
  );
}

async function loadUsagePackCheckoutAllocations(
  args: {
    readonly clerk: ClerkClient;
    readonly orgId: string;
    readonly selections: readonly MemberUsagePack[];
  },
  signal: AbortSignal,
): Promise<readonly UsagePackCheckoutAllocation[] | null> {
  const catalog = await loadUsagePackCatalog();
  signal.throwIfAborted();
  const { memberships, invitations } = await loadBillingOrganizationDirectory(
    args.clerk,
    args.orgId,
    signal,
  );
  signal.throwIfAborted();
  return usagePackCheckoutAllocations(
    args.selections,
    memberships,
    invitations,
    catalog,
  );
}

function hasActiveLegacyPlanSubscription(
  metadata:
    | {
        readonly tier: string | null;
        readonly stripeSubscriptionId: string | null;
        readonly subscriptionStatus: string | null;
      }
    | undefined,
): boolean {
  return Boolean(
    metadata?.stripeSubscriptionId &&
    metadata.subscriptionStatus === "active" &&
    (metadata.tier === "pro" || metadata.tier === "team"),
  );
}

function usagePackCheckoutTierConflicts(
  metadata:
    | {
        readonly tier: string | null;
        readonly subscriptionStatus: string | null;
      }
    | undefined,
  targetTier: SubscriptionCheckoutTier,
): boolean {
  const configuresGrantedPlan =
    metadata?.subscriptionStatus === "atom_grant" &&
    metadata.tier === targetTier;
  return (
    !configuresGrantedPlan &&
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: metadata?.tier,
      targetTier,
    })
  );
}

const googleAdsPaidConversion$ = command(
  async (
    { get },
    invoice: StripeInvoice | null,
    orgId: string,
    signal: AbortSignal,
  ) => {
    const amountPaidCents = invoice?.amount_paid ?? 0;
    if (
      invoice?.status !== "paid" ||
      invoice.currency.toLowerCase() !== "usd" ||
      amountPaidCents <= 0
    ) {
      return undefined;
    }

    // Invoice attribution is a frozen checkout snapshot. Never fill an unknown
    // invoice click with a campaign from a different touch or organization.
    const snapshots = [
      invoice.metadata,
      invoice.parent?.subscription_details?.metadata,
    ];
    const attribution = snapshots.find((metadata) => {
      return (
        metadata &&
        [
          "gclid",
          "gbraid",
          "wbraid",
          "okou_campaign_id",
          "vm0_campaign_id",
        ].some((key) => {
          return metadata[key];
        })
      );
    });
    let googleAdsAccountId: string | null;
    if (attribution) {
      googleAdsAccountId = googleAdsAccountForAttribution(attribution);
    } else {
      const [org] = await get(db$)
        .select({
          campaignId: orgMetadata.acquisitionCampaignId,
          adGroupId: orgMetadata.acquisitionAdGroupId,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      googleAdsAccountId = googleAdsAccountForAttribution({
        okou_campaign_id: org?.campaignId ?? undefined,
        okou_ad_group_id: org?.adGroupId ?? undefined,
      });
    }
    // Legacy paid conversions are UPLOAD_CLICKS and remain on the offline path.
    // Omitting this optional payload also protects already-open old clients.
    if (googleAdsAccountId !== GOOGLE_ADS_ADSMARCH_ACCOUNT_ID) {
      return undefined;
    }
    return {
      transactionId: invoice.id,
      valueUsd: amountPaidCents / 100,
      googleAdsAccountId,
    };
  },
);

const confirmPlanPurchaseForOrg$ = command(
  async ({ set }, orgId: string, previewToken: string, signal: AbortSignal) => {
    const result = await set(confirmPlanPurchase$, orgId, previewToken, signal);
    signal.throwIfAborted();
    if (result.status === "invalid_preview") {
      return conflict("Plan purchase preview is no longer valid");
    }
    if (result.paidInvoice) {
      const reconciledOrgId = await set(
        reconcilePaidStripeInvoice$,
        result.paidInvoice,
        signal,
      );
      signal.throwIfAborted();
      if (reconciledOrgId !== orgId) {
        throw new Error(
          `Paid Plan purchase invoice ${result.paidInvoice.id} did not reconcile to org ${orgId}`,
        );
      }
    }
    const conversion = await set(
      googleAdsPaidConversion$,
      result.paidInvoice,
      orgId,
      signal,
    );
    return {
      status: 200 as const,
      body:
        result.response.status === "completed" && conversion
          ? { ...result.response, googleAdsConversion: conversion }
          : result.response,
    };
  },
);

const checkoutAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(billingCheckoutContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (bodyResult.data.previewToken) {
    const confirmation = await set(
      confirmPlanPurchaseForOrg$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
    signal.throwIfAborted();
    if (confirmation.status !== 409) {
      return confirmation;
    }
  }
  const {
    tier,
    supportsInAppPreview,
    successUrl,
    cancelUrl,
    trialDays,
    adAttribution,
  } = bodyResult.data;
  const previewEnabled = supportsInAppPreview === true;
  const clerk = get(clerk$);
  const acquisition = await checkoutAttribution(
    clerk,
    auth.userId,
    adAttribution,
    signal,
  );
  const resolvedAttribution = {
    ...acquisition,
    ...(await set(impactStripeMetadata$, auth.orgId, signal)),
  };

  if (!checkoutRedirectsAllowed(successUrl, cancelUrl)) {
    return badRequestMessage(
      "successUrl and cancelUrl must match the platform origin",
    );
  }

  const priceId = activePriceId(tier);
  if (!priceId) {
    return badRequestMessage(`Price not configured for ${tier} tier`);
  }

  const db = get(db$);
  const [metadata] = await db
    .select({
      onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: metadata?.tier,
      targetTier: tier,
    })
  ) {
    return badRequestMessage(
      checkoutTierConflictMessage({
        currentTier: metadata?.tier,
        targetTier: tier,
      }),
    );
  }

  if (trialDays !== undefined) {
    if (tier !== "pro") {
      return badRequestMessage("Trial checkout is only available for Pro tier");
    }
    if (metadata?.onboardingPaymentPending !== true) {
      return badRequestMessage(
        "Pro trial checkout is only available during onboarding",
      );
    }
  }

  const result = await set(
    startPlanPurchase$,
    {
      orgId: auth.orgId,
      tier,
      priceId,
      trialDays,
      successUrl,
      cancelUrl,
      adAttribution: resolvedAttribution,
      supportsInAppPreview: previewEnabled,
      subscriptionId: metadata?.stripeSubscriptionId ?? null,
    },
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: result.status === "preview" ? result.preview : { url: result.url },
  };
});

const checkout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutAuthed$,
    ),
    signal,
  );
});

const checkoutConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const bodyResult = await get(bodyResultOf(billingCheckoutContract.confirm));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      confirmPlanPurchaseForOrg$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
  },
);

const checkoutConfirm$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutConfirmAuthed$,
    ),
    signal,
  );
});

const confirmUsagePackPurchaseForOrg$ = command(
  async (
    { get, set },
    orgId: string,
    previewToken: string,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    if (!(await usagePackPurchaseSerializationSchemaAvailable(db))) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    signal.throwIfAborted();
    const result = await set(
      confirmUsagePackPurchase$,
      orgId,
      previewToken,
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "invalid_preview") {
      return conflict("Usage pack purchase preview is no longer valid");
    }
    if (result.paidInvoice) {
      const reconciledOrgId = await set(
        reconcilePaidStripeInvoice$,
        result.paidInvoice,
        signal,
      );
      signal.throwIfAborted();
      if (reconciledOrgId !== orgId) {
        throw new Error(
          `Paid usage pack purchase invoice ${result.paidInvoice.id} did not reconcile to org ${orgId}`,
        );
      }
    }
    const conversion = await set(
      googleAdsPaidConversion$,
      result.paidInvoice,
      orgId,
      signal,
    );
    return {
      status: 200 as const,
      body:
        result.response.status === "completed" && conversion
          ? { ...result.response, googleAdsConversion: conversion }
          : result.response,
    };
  },
);

const usagePackCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(
      bodyResultOf(billingUsagePackCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data;
    if (!hasPaidUsagePack(body.memberUsagePacks)) {
      return badRequestMessage(
        "At least one member must have a paid usage pack",
      );
    }
    if (body.previewToken) {
      return await set(
        confirmUsagePackPurchaseForOrg$,
        auth.orgId,
        body.previewToken,
        signal,
      );
    }

    const db = get(db$);
    if (!(await usagePackPurchaseSerializationSchemaAvailable(db))) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    signal.throwIfAborted();

    const previewEnabled = body.supportsInAppPreview === true;
    const clerk = get(clerk$);
    const acquisition = await checkoutAttribution(
      clerk,
      auth.userId,
      body.adAttribution,
      signal,
    );
    const resolvedAttribution = {
      ...acquisition,
      ...(await set(impactStripeMetadata$, auth.orgId, signal)),
    };

    if (!checkoutRedirectsAllowed(body.successUrl, body.cancelUrl)) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const planPriceId = activeUsagePackPlanPriceId(body.tier);
    if (!planPriceId) {
      return badRequestMessage(
        `Usage pack plan price not configured for ${body.tier} tier`,
      );
    }

    const [metadata] = await db
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, auth.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (hasActiveLegacyPlanSubscription(metadata)) {
      return badRequestMessage(
        "Existing subscriptions must migrate before starting usage pack checkout",
      );
    }

    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const allocations = await loadUsagePackCheckoutAllocations(
      {
        clerk,
        orgId: auth.orgId,
        selections: body.memberUsagePacks,
      },
      readSignal,
    );
    signal.throwIfAborted();
    if (!allocations) {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }

    if (usagePackCheckoutTierConflicts(metadata, body.tier)) {
      return badRequestMessage(
        checkoutTierConflictMessage({
          currentTier: metadata?.tier,
          targetTier: body.tier,
        }),
      );
    }

    const result = await set(
      startUsagePackPurchase$,
      {
        orgId: auth.orgId,
        tier: body.tier,
        planPriceId,
        allocations,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        adAttribution: resolvedAttribution,
        supportsInAppPreview: previewEnabled,
        sourceSubscriptionId: metadata?.stripeSubscriptionId ?? null,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: result.status === "preview" ? result.preview : { url: result.url },
    };
  },
);

const usagePackCheckoutConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackCheckoutContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      confirmUsagePackPurchaseForOrg$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
  },
);

const usagePackCatalogAuthed$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const usagePacks = await loadUsagePackCatalog();
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { usagePacks: [...usagePacks], supportsFreeMembers: true },
    };
  },
);

const usagePackCatalog$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      usagePackCatalogAuthed$,
    ),
    signal,
  );
});

const usagePackCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      withBillingClerkRateLimit(usagePackCheckoutAuthed$),
    ),
    signal,
  );
});

const usagePackCheckoutConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackCheckoutConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackManagementAccess$ = command(({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return { allowed: false as const, response: adminRequired };
  }
  signal.throwIfAborted();
  return { allowed: true as const, auth };
});

const usagePackManagementGetAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const db = get(db$);
    const [subscriptionSchema, changeSchema, memberAdditionSchema] =
      await Promise.all([
        usagePackSubscriptionSchemaAvailable(db),
        usagePackAllocationChangeSchemaAvailable(db),
        usagePackMemberAdditionSchemaAvailable(db),
      ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const management = await getUsagePackManagement(
      db,
      access.auth.orgId,
      memberAdditionSchema,
    );
    signal.throwIfAborted();
    if (!management) {
      return notFound("Usage pack subscription not found");
    }
    return { status: 200 as const, body: management };
  },
);

const usagePackChangePreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackManagementContract.previewChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const previewEnabled = bodyResult.data.supportsInAppPreview === true;
    if (
      !billingPreviewReturnUrlAllowed(previewEnabled, bodyResult.data.returnUrl)
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const result = await previewUsagePackAllocationChange(
      db,
      {
        orgId: access.auth.orgId,
        userId: bodyResult.data.memberId,
        targetUsagePackUsd: bodyResult.data.targetUsagePackUsd,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack allocation not found");
    }
    if (result.status === "same_package") {
      return badRequestMessage("Member already has this usage pack");
    }
    if (result.status === "plan_ending") {
      return conflict(USAGE_PACK_PLAN_ENDING_MESSAGE);
    }
    if (result.status === "conflict") {
      return conflict("Another usage pack billing change is in progress");
    }
    if (
      result.preview.immediateAmountCents > 0 &&
      previewEnabled &&
      bodyResult.data.returnUrl
    ) {
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (!billing) {
        return notFound("Usage pack subscription not found");
      }
      const route = await routeBillingPurchasePreview(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: billing.stripeCustomerId,
          subscriptionId: billing.stripeSubscriptionId,
          operation: "usage_pack_allocation",
          operationId: result.preview.changeId,
          returnUrl: bodyResult.data.returnUrl,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: {
          ...result.preview,
          ...(route.paymentMethodPreviewToken
            ? { paymentMethodPreviewToken: route.paymentMethodPreviewToken }
            : {}),
        },
      };
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackChangeConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackManagementContract.confirmChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { changeId } = get(
      pathParamsOf(billingUsagePackManagementContract.confirmChange),
    );
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (bodyResult.data.paymentMethodPreviewToken) {
      const preview = parseBillingPaymentMethodPreviewToken(
        bodyResult.data.paymentMethodPreviewToken,
      );
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (
        !preview ||
        !billing ||
        preview.operation !== "usage_pack_allocation" ||
        preview.operationId !== changeId ||
        preview.orgId !== access.auth.orgId ||
        preview.customerId !== billing.stripeCustomerId ||
        preview.subscriptionId !== billing.stripeSubscriptionId ||
        new Date(preview.expiresAt) <= nowDate()
      ) {
        return conflict("Usage pack change preview is no longer valid");
      }
      const revalidated = await revalidateBillingPurchase(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: preview.customerId,
          subscriptionId: preview.subscriptionId,
          paymentMethodId: preview.paymentMethodId,
          operation: preview.operation,
          operationId: preview.operationId,
          returnUrl: preview.returnUrl,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Usage pack change preview is no longer valid");
      }
      if (revalidated.kind === "preview") {
        paymentMethod = revalidated;
      }
    }
    const result = await confirmUsagePackAllocationChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId,
        paymentMethod,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack change not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack change preview expired");
    }
    if (result.status === "plan_ending") {
      return conflict(USAGE_PACK_PLAN_ENDING_MESSAGE);
    }
    if (result.status === "conflict") {
      return conflict("Usage pack allocation changed; create a new preview");
    }
    return { status: 200 as const, body: result.response };
  },
);

async function usagePackMigrationSchemasAvailable(
  db: Parameters<typeof usagePackSubscriptionSchemaAvailable>[0],
): Promise<boolean> {
  const [subscriptionSchema, invitationSchema] = await Promise.all([
    usagePackSubscriptionSchemaAvailable(db),
    usagePackInvitationPurchaseSchemaAvailable(db),
  ]);
  return subscriptionSchema && invitationSchema;
}

const usagePackMigrationGetAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    signal.throwIfAborted();
    const result = await getUsagePackMigrationState(db, access.auth.orgId);
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Legacy subscription migration is not available");
    }
    if (result.status === "conflict") {
      return conflict("Another subscription update is in progress");
    }
    const query = get(queryOf(billingUsagePackMigrationContract.get));
    // Loaded browsers require at least one paid selection in configuration.
    // Preserve their optional-field response until they opt in to Free members.
    const configuration = result.state.configuration;
    return {
      status: 200 as const,
      body: {
        ...result.state,
        configuration:
          configuration?.memberUsagePacks.length === 0 &&
          !query?.supportsFreeMembers
            ? undefined
            : configuration,
      },
    };
  },
);

const usagePackMigrationPreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackMigrationContract.preview),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const { memberships, invitations } = await loadBillingOrganizationDirectory(
      clerk,
      access.auth.orgId,
      readSignal,
    );
    signal.throwIfAborted();
    const result = await previewUsagePackSubscriptionMigration(
      db,
      {
        orgId: access.auth.orgId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Eligible legacy subscription not found");
    }
    if (result.status === "owners_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (result.status === "conflict") {
      return conflict("Another subscription update is in progress");
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackMigrationConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackMigrationContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(billingUsagePackMigrationContract.confirm),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const { memberships, invitations } = await loadBillingOrganizationDirectory(
      clerk,
      access.auth.orgId,
      readSignal,
    );
    signal.throwIfAborted();
    const ownerIds = usagePackMigrationOwners(
      memberships,
      invitations,
      access.auth.userId,
    ).map((owner) => {
      return "userId" in owner ? owner.userId : owner.invitationId;
    });
    const result = await confirmUsagePackSubscriptionMigration(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        ownerIds,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack migration not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack migration preview expired");
    }
    if (result.status === "owners_changed") {
      return conflict(
        "Organization members changed; create a new migration preview",
      );
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration is no longer available");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackMigrationRevisionPreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackMigrationContract.previewRevision),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(billingUsagePackMigrationContract.previewRevision),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const { memberships, invitations } = await loadBillingOrganizationDirectory(
      clerk,
      access.auth.orgId,
      readSignal,
    );
    signal.throwIfAborted();
    const result = await previewUsagePackSubscriptionMigrationRevision(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Scheduled usage pack migration not found");
    }
    if (result.status === "owners_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (result.status === "same_configuration") {
      return badRequestMessage("The migration configuration is unchanged");
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration cannot be revised");
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackMigrationRevisionConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(billingUsagePackMigrationContract.confirmRevision),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(billingUsagePackMigrationContract.confirmRevision),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const { memberships, invitations } = await loadBillingOrganizationDirectory(
      clerk,
      access.auth.orgId,
      readSignal,
    );
    signal.throwIfAborted();
    const result = await confirmUsagePackSubscriptionMigrationRevision(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
        previewToken: bodyResult.data.previewToken,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Scheduled usage pack migration not found");
    }
    if (result.status === "invalid_preview") {
      return badRequestMessage(
        "Usage pack migration preview is invalid or expired",
      );
    }
    if (result.status === "owners_changed") {
      return conflict(
        "Organization members changed; create a new migration preview",
      );
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration configuration changed");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackManagementGet$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackManagementGetAuthed$,
      ),
      signal,
    );
  },
);

const usagePackChangePreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackChangePreviewAuthed$,
      ),
      signal,
    );
  },
);

const usagePackChangeConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackChangeConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackSubscriptionChangePreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(
        billingUsagePackManagementContract.previewSubscriptionChange,
      ),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (!hasPaidUsagePack(bodyResult.data.memberUsagePacks)) {
      return badRequestMessage(
        "At least one member must have a paid usage pack",
      );
    }
    const previewEnabled = bodyResult.data.supportsInAppPreview === true;
    if (
      !billingPreviewReturnUrlAllowed(previewEnabled, bodyResult.data.returnUrl)
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const db = set(writeDb$);
    const [
      subscriptionSchema,
      changeSchema,
      subscriptionChangeSchema,
      memberAdditionSchema,
    ] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
      usagePackSubscriptionChangeSchemaAvailable(db),
      usagePackMemberAdditionSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema || !subscriptionChangeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const management = await getUsagePackManagement(db, access.auth.orgId);
    signal.throwIfAborted();
    if (!management) {
      return notFound("Usage pack subscription not found");
    }
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const memberValidation = await validateUsagePackSubscriptionMembers(
      {
        clerk: get(clerk$),
        orgId: access.auth.orgId,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        allocatedMemberIds: management.allocations.map((allocation) => {
          return allocation.memberId;
        }),
        memberAdditionSchemaAvailable: memberAdditionSchema,
      },
      readSignal,
    );
    signal.throwIfAborted();
    if (memberValidation === "member_additions_unavailable") {
      return providerUnavailable("Usage pack member additions are not ready");
    }
    if (memberValidation === "members_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    const result = await previewUsagePackSubscriptionChange(
      db,
      {
        orgId: access.auth.orgId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack subscription not found");
    }
    if (result.status === "same_configuration") {
      return badRequestMessage("The subscription configuration is unchanged");
    }
    if (result.status === "invalid_members") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (isUsagePackSubscriptionChangeConflict(result)) {
      return conflict(
        USAGE_PACK_SUBSCRIPTION_CHANGE_CONFLICT_MESSAGES[result.status],
      );
    }
    if (
      result.preview.immediateAmountCents > 0 &&
      previewEnabled &&
      bodyResult.data.returnUrl
    ) {
      const paymentRoute = await routeUsagePackSubscriptionChangePayment(
        {
          db,
          orgId: access.auth.orgId,
          preview: result.preview,
          returnUrl: bodyResult.data.returnUrl,
        },
        signal,
      );
      if (paymentRoute.kind === "not_found") {
        return notFound("Usage pack subscription not found");
      }
      return { status: 200 as const, body: paymentRoute.body };
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackSubscriptionChangeConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(
        billingUsagePackManagementContract.confirmSubscriptionChange,
      ),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema, subscriptionChangeSchema] =
      await Promise.all([
        usagePackSubscriptionSchemaAvailable(db),
        usagePackAllocationChangeSchemaAvailable(db),
        usagePackSubscriptionChangeSchemaAvailable(db),
      ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema || !subscriptionChangeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (bodyResult.data.paymentMethodPreviewToken) {
      const preview = parseBillingPaymentMethodPreviewToken(
        bodyResult.data.paymentMethodPreviewToken,
      );
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (
        !preview ||
        !billing ||
        preview.operation !== "usage_pack_subscription" ||
        preview.operationId !== bodyResult.data.changeId ||
        preview.orgId !== access.auth.orgId ||
        preview.customerId !== billing.stripeCustomerId ||
        preview.subscriptionId !== billing.stripeSubscriptionId ||
        new Date(preview.expiresAt) <= nowDate()
      ) {
        return conflict("Usage pack subscription preview is no longer valid");
      }
      const revalidated = await revalidateBillingPurchase(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: preview.customerId,
          subscriptionId: preview.subscriptionId,
          paymentMethodId: preview.paymentMethodId,
          operation: preview.operation,
          operationId: preview.operationId,
          returnUrl: preview.returnUrl,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Usage pack subscription preview is no longer valid");
      }
      if (revalidated.kind === "preview") {
        paymentMethod = revalidated;
      }
    }
    const result = await confirmUsagePackSubscriptionChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId: bodyResult.data.changeId,
        paymentMethod,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack subscription not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack subscription preview expired");
    }
    if (isUsagePackSubscriptionChangeConflict(result)) {
      return conflict(
        USAGE_PACK_SUBSCRIPTION_CHANGE_CONFLICT_MESSAGES[result.status],
      );
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackSubscriptionChangePreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        withBillingClerkRateLimit(usagePackSubscriptionChangePreviewAuthed$),
      ),
      signal,
    );
  },
);

const usagePackMigrationGet$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      usagePackMigrationGetAuthed$,
    ),
    signal,
  );
});

const usagePackMigrationPreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        withBillingClerkRateLimit(usagePackMigrationPreviewAuthed$),
      ),
      signal,
    );
  },
);

const usagePackMigrationConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        withBillingClerkRateLimit(usagePackMigrationConfirmAuthed$),
      ),
      signal,
    );
  },
);

const usagePackMigrationRevisionPreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        withBillingClerkRateLimit(usagePackMigrationRevisionPreviewAuthed$),
      ),
      signal,
    );
  },
);

const usagePackMigrationRevisionConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        withBillingClerkRateLimit(usagePackMigrationRevisionConfirmAuthed$),
      ),
      signal,
    );
  },
);

const usagePackSubscriptionChangeConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackSubscriptionChangeConfirmAuthed$,
      ),
      signal,
    );
  },
);

const checkoutCompleteAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingCheckoutContract.complete),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      completeCheckoutSession$,
      { orgId: auth.orgId, sessionId: bodyResult.data.sessionId },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "customer_mismatch") {
      return badRequestMessage(
        "Checkout session does not belong to current organization",
      );
    }
    if (result.status === "tier_conflict") {
      return badRequestMessage(
        checkoutTierConflictMessage({
          currentTier: result.currentTier,
          targetTier: result.targetTier,
        }),
      );
    }

    if (result.status === "pending") {
      return { status: 200 as const, body: { completed: false } };
    }

    if (result.status === "paid_invoice_ready") {
      const reconciledOrgId = await set(
        reconcilePaidStripeInvoice$,
        result.paidInvoice,
        signal,
      );
      signal.throwIfAborted();
      if (reconciledOrgId !== auth.orgId) {
        throw new Error(
          `Paid Checkout invoice ${result.paidInvoice.id} did not reconcile to org ${auth.orgId}`,
        );
      }
    }

    const conversion = await set(
      googleAdsPaidConversion$,
      result.paidInvoice,
      auth.orgId,
      signal,
    );
    return {
      status: 200 as const,
      body: {
        completed: true,
        ...(conversion ? { googleAdsConversion: conversion } : {}),
      },
    };
  },
);

const checkoutComplete$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutCompleteAuthed$,
    ),
    signal,
  );
});

export const billingCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: billingCheckoutContract.create,
    handler: checkout$,
  },
  {
    route: billingCheckoutContract.confirm,
    handler: checkoutConfirm$,
  },
  {
    route: billingCheckoutContract.complete,
    handler: checkoutComplete$,
  },
  {
    route: billingUsagePackCheckoutContract.create,
    handler: usagePackCheckout$,
  },
  {
    route: billingUsagePackCheckoutContract.confirm,
    handler: usagePackCheckoutConfirm$,
  },
  {
    route: billingUsagePackCatalogContract.get,
    handler: usagePackCatalog$,
  },
  {
    route: billingUsagePackManagementContract.get,
    handler: usagePackManagementGet$,
  },
  {
    route: billingUsagePackManagementContract.previewChange,
    handler: usagePackChangePreview$,
  },
  {
    route: billingUsagePackManagementContract.confirmChange,
    handler: usagePackChangeConfirm$,
  },
  {
    route: billingUsagePackManagementContract.previewSubscriptionChange,
    handler: usagePackSubscriptionChangePreview$,
  },
  {
    route: billingUsagePackManagementContract.confirmSubscriptionChange,
    handler: usagePackSubscriptionChangeConfirm$,
  },
  {
    route: billingUsagePackMigrationContract.get,
    handler: usagePackMigrationGet$,
  },
  {
    route: billingUsagePackMigrationContract.preview,
    handler: usagePackMigrationPreview$,
  },
  {
    route: billingUsagePackMigrationContract.confirm,
    handler: usagePackMigrationConfirm$,
  },
  {
    route: billingUsagePackMigrationContract.previewRevision,
    handler: usagePackMigrationRevisionPreview$,
  },
  {
    route: billingUsagePackMigrationContract.confirmRevision,
    handler: usagePackMigrationRevisionConfirm$,
  },
];
