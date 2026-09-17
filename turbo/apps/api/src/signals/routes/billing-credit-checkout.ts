import { command } from "ccstate";
import { billingCreditCheckoutContract } from "@okouai/api-contracts/contracts/billing";
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
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { ensureOrgMetadataPlanEntitlement } from "../services/org-plan-entitlements.service";
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

    const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
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
      const db = set(writeDb$);
      await db.transaction(async (tx) => {
        const rows = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId: auth.orgId })
          .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
          .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
        for (const row of rows) {
          await ensureOrgMetadataPlanEntitlement(tx, row);
        }
        signal.throwIfAborted();
      });
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
    const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
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

const creditCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:write",
      },
      creditCheckoutAuthed$,
    ),
    signal,
  );
});

const creditPurchaseConfirm$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(
    authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:write",
      },
      creditPurchaseConfirmAuthed$,
    ),
    signal,
  );
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
