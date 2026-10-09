import { command, computed } from "ccstate";
import { billingCreditCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  activeCustomCreditUnitPriceId,
  confirmExistingBillingCreditPurchase$,
  createCreditCheckoutSession$,
  previewExistingBillingCreditPurchase$,
} from "../services/billing-checkout.service";
import { updateAutoRechargeConfig$ } from "../services/billing.service";
import {
  ORG_PLAN_CAPABILITY_SELECTION,
  orgPlanCapabilitiesFromRow,
} from "../services/org-plan-entitlement-read.service";
import { orgPlanEntitlementValues } from "../services/org-plan-entitlements.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can buy credits",
      code: "FORBIDDEN",
    }),
  }),
});

const creditPurchaseCapabilities$ = computed(async (get) => {
  const { orgId } = get(organizationAuthContext$);
  const db = get(db$);
  const [row] = await db
    .select({
      planKey: ORG_PLAN_CAPABILITY_SELECTION.planKey,
      status: ORG_PLAN_CAPABILITY_SELECTION.status,
      baseConcurrencyLimit: ORG_PLAN_CAPABILITY_SELECTION.baseConcurrencyLimit,
      canBuyConcurrency: ORG_PLAN_CAPABILITY_SELECTION.canBuyConcurrency,
      canBuyCredits: ORG_PLAN_CAPABILITY_SELECTION.canBuyCredits,
      showUsagePack: ORG_PLAN_CAPABILITY_SELECTION.showUsagePack,
      autoRechargeAllowed: ORG_PLAN_CAPABILITY_SELECTION.autoRechargeAllowed,
      restrictedBuiltInModels:
        ORG_PLAN_CAPABILITY_SELECTION.restrictedBuiltInModels,
      workflowWebhookAutomationAllowed:
        ORG_PLAN_CAPABILITY_SELECTION.workflowWebhookAutomationAllowed,
      audioLifetimeLimit: ORG_PLAN_CAPABILITY_SELECTION.audioLifetimeLimit,
      audioDailyRateLimit: ORG_PLAN_CAPABILITY_SELECTION.audioDailyRateLimit,
      audioDailyDurationSeconds:
        ORG_PLAN_CAPABILITY_SELECTION.audioDailyDurationSeconds,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  if (row) {
    return orgPlanCapabilitiesFromRow(row, orgId);
  }
  const [org] = await db
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (!org) {
    return null;
  }
  throw new Error(`Missing org plan entitlement for ${orgId}`);
});

const bootstrapCreditAutoRechargeOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    // Only newly inserted metadata publishes a default entitlement. Keep both
    // writes atomic without repairing or replacing an existing Plan.
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId })
        .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      signal.throwIfAborted();
      for (const row of rows) {
        const tier = orgTierSchema.safeParse(row.tier);
        if (!tier.success) {
          continue;
        }
        await tx
          .insert(orgPlanEntitlements)
          .values(
            orgPlanEntitlementValues(
              {
                orgId: row.orgId,
                tier: tier.data,
                source: "org_metadata_migration",
              },
              { stripeSubscriptionId: null, sourceMetadata: {} },
            ),
          )
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

const creditCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingCreditCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const {
      credits,
      successUrl,
      cancelUrl,
      autoRecharge,
      previewExistingBilling,
      supportsInAppPreview,
    } = bodyResult.data;

    const capabilities = await get(creditPurchaseCapabilities$);
    signal.throwIfAborted();
    if (capabilities?.canBuyCredits === false) {
      return badRequestMessage(
        "Credit purchases are not available for this workspace",
      );
    }

    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    if (!activeCustomCreditUnitPriceId()) {
      return badRequestMessage("Custom credit price not configured");
    }

    if (autoRecharge?.enabled === true) {
      const threshold = autoRecharge.threshold;
      const amount = autoRecharge.amount;
      if (threshold === undefined || amount === undefined) {
        return badRequestMessage(
          "auto-recharge requires both threshold and amount",
        );
      }
      await set(bootstrapCreditAutoRechargeOrg$, auth.orgId, signal);
      signal.throwIfAborted();
      const updateResult = await set(
        updateAutoRechargeConfig$,
        {
          orgId: auth.orgId,
          enabled: true,
          threshold,
          amount,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!updateResult.ok) {
        return badRequestMessage(updateResult.error);
      }
    }

    // This shared route also serves the commit-addressed CLI, which requires
    // hosted Checkout, so in-app preview remains an explicit client opt-in.
    const previewEnabled =
      supportsInAppPreview === true || previewExistingBilling === true;
    if (previewEnabled) {
      const preview = await set(
        previewExistingBillingCreditPurchase$,
        { orgId: auth.orgId, credits, successUrl, cancelUrl },
        signal,
      );
      if (preview) {
        return { status: 200 as const, body: preview };
      }
    }

    const url = await set(
      createCreditCheckoutSession$,
      {
        orgId: auth.orgId,
        credits,
        successUrl,
        cancelUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    if (autoRecharge?.enabled === false) {
      const db = set(writeDb$);
      await db
        .update(orgMetadata)
        .set({
          autoRechargeEnabled: false,
          autoRechargeThreshold: null,
          autoRechargeAmount: null,
          autoRechargePendingAt: null,
        })
        .where(eq(orgMetadata.orgId, auth.orgId));
      signal.throwIfAborted();
    }

    return { status: 200 as const, body: { url } };
  },
);

const creditPurchaseConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingCreditCheckoutContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const capabilities = await get(creditPurchaseCapabilities$);
    signal.throwIfAborted();
    if (capabilities?.canBuyCredits === false) {
      return badRequestMessage(
        "Credit purchases are not available for this workspace",
      );
    }
    if (!activeCustomCreditUnitPriceId()) {
      return badRequestMessage("Custom credit price not configured");
    }

    const result = await set(
      confirmExistingBillingCreditPurchase$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
    if (result.status === "invalid_preview") {
      return badRequestMessage(
        "Credit purchase preview expired or is no longer valid",
      );
    }
    if (result.status === "billing_unavailable") {
      return conflict("Saved billing is no longer available");
    }
    return { status: 200 as const, body: result.response };
  },
);

const creditCheckoutAuth$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "billing:write",
  },
  creditCheckoutAuthed$,
);

const creditPurchaseConfirmAuth$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "billing:write",
  },
  creditPurchaseConfirmAuthed$,
);

const creditCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(creditCheckoutAuth$, signal);
});

const creditPurchaseConfirm$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(creditPurchaseConfirmAuth$, signal);
});

export const billingCreditCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: billingCreditCheckoutContract.create,
    handler: creditCheckout$,
  },
  {
    route: billingCreditCheckoutContract.confirm,
    handler: creditPurchaseConfirm$,
  },
];
