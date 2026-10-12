import { command, computed } from "ccstate";
import { billingCreditCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

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
  // Read Plan and metadata in one snapshot: separate reads can mistake a
  // concurrent atomic bootstrap for metadata without a Plan. Either table
  // contributes the identity so an existing Plan never requires metadata.
  const identity = db.$with("credit_purchase_identity").as(
    db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .union(
        db
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(eq(orgPlanEntitlements.orgId, orgId)),
      ),
  );
  const [row] = await db
    .with(identity)
    .select({ plan: ORG_PLAN_CAPABILITY_SELECTION })
    .from(identity)
    .leftJoin(
      orgPlanEntitlements,
      eq(orgPlanEntitlements.orgId, identity.orgId),
    );
  if (!row) {
    return null;
  }
  if (row.plan) {
    return orgPlanCapabilitiesFromRow(row.plan, orgId);
  }
  throw new Error(`Missing org plan entitlement for ${orgId}`);
});

const bootstrapCreditAutoRechargeOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const metadata = db
      .insert(orgMetadataCanonicalWrites)
      .values({ orgId })
      .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
      .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier })
      .getSQL();
    // Match the actual returned tier, not the attempted default. Unknown tiers
    // have no values row and retain the previous safeParse skip.
    const entitlementRows = orgTierSchema.options.map((tier) => {
      const values = orgPlanEntitlementValues(
        { orgId, tier, source: "org_metadata_migration" },
        { stripeSubscriptionId: null, sourceMetadata: {} },
      );
      return sql`(${values.planKey}, ${values.planRank}::integer,
        ${values.source}, ${values.status}, ${values.baseConcurrencyLimit}::integer,
        ${values.canBuyConcurrency}::boolean, ${values.canBuyCredits}::boolean,
        ${values.showUsagePack}::boolean, ${values.autoRechargeAllowed}::boolean,
        ${values.restrictedBuiltInModels}::boolean,
        ${values.workflowWebhookTriggerAllowed}::boolean,
        ${values.audioLifetimeLimit}::integer, ${values.audioDailyRateLimit}::integer,
        ${values.audioDailyDurationSeconds}::integer, ${values.stripeSubscriptionId},
        ${values.stripePriceId},
        ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)}::timestamp,
        ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)}::timestamp,
        ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)}::timestamp,
        ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)}::timestamp,
        ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb,
        ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}::timestamp)`;
    });
    // Drizzle insert-select requires every target column. Keep this partial
    // target list so omitted fields retain their database defaults.
    // Only newly inserted metadata publishes a Plan; neither conflict repairs
    // or replaces an existing Plan. Publication is one atomic statement.
    await db.execute(sql`WITH metadata AS (${metadata}), entitlement_values (
      plan_key, plan_rank, source, status, base_concurrency_limit,
      can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
      restricted_built_in_models, workflow_webhook_trigger_allowed,
      audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
      stripe_subscription_id, stripe_price_id, current_period_start,
      current_period_end, cancel_at, expires_at, source_metadata, updated_at
    ) AS (VALUES ${sql.join(entitlementRows, sql`, `)})
      INSERT INTO ${orgPlanEntitlements} (
        org_id, plan_key, plan_rank, source, status, base_concurrency_limit,
        can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
        restricted_built_in_models, workflow_webhook_trigger_allowed,
        audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
        stripe_subscription_id, stripe_price_id, current_period_start,
        current_period_end, cancel_at, expires_at, source_metadata, updated_at
      ) SELECT metadata.org_id, entitlement_values.* FROM metadata
        JOIN entitlement_values ON ${eq(sql`metadata.tier`, sql`entitlement_values.plan_key`)}
      ON CONFLICT (org_id) DO NOTHING`);
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
