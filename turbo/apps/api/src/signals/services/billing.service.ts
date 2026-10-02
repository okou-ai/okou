import { command, computed, type Computed } from "ccstate";
import type { AutoRechargeConfig } from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { eq } from "drizzle-orm";

import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  ensurePaymentMethodPortalConfiguration,
  getStripeClient,
} from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

export function autoRechargeConfig(
  orgId: string,
): Computed<Promise<AutoRechargeConfig>> {
  return computed(async (get): Promise<AutoRechargeConfig> => {
    const db = get(db$);
    const [row] = await db
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return {
      enabled: row?.autoRechargeEnabled ?? false,
      threshold: row?.autoRechargeThreshold ?? null,
      amount: row?.autoRechargeAmount ?? null,
    };
  });
}

async function stripeCustomerIdForOrg(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [org] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (org?.stripeCustomerId) {
    return org.stripeCustomerId;
  }

  const [allowance] = await db
    .select({
      stripeCustomerId: orgUsageAllowanceEntitlements.stripeCustomerId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .limit(1);
  return allowance?.stripeCustomerId ?? null;
}

/** Create either a legacy billing or restricted payment-method portal. */
export const createBillingPortalSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly returnUrl: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    let stripeCustomerId = await stripeCustomerIdForOrg(db, args.orgId);
    signal.throwIfAborted();

    if (!stripeCustomerId) {
      stripeCustomerId = await set(
        getOrCreateStripeCustomer$,
        { orgId: args.orgId },
        signal,
      );
      signal.throwIfAborted();
    }

    const stripe = getStripeClient();
    const portalConfigurationId =
      await ensurePaymentMethodPortalConfiguration(signal);
    signal.throwIfAborted();

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      configuration: portalConfigurationId,
      return_url: args.returnUrl,
    });
    signal.throwIfAborted();

    return session.url;
  },
);

type UpdateAutoRechargeResult =
  | { readonly ok: true; readonly data: AutoRechargeConfig }
  | { readonly ok: false; readonly error: string };

interface UpdateAutoRechargeArgs {
  readonly orgId: string;
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}

export const updateAutoRechargeConfig$ = command(
  async (
    { set },
    args: UpdateAutoRechargeArgs,
    signal: AbortSignal,
  ): Promise<UpdateAutoRechargeResult> => {
    const { orgId, enabled, threshold, amount } = args;
    const writeDb = set(writeDb$);

    if (enabled) {
      const capabilities = await set(loadOrgPlanCapabilities$, orgId, signal);
      signal.throwIfAborted();

      if (capabilities?.autoRechargeAllowed !== true) {
        return {
          ok: false,
          error:
            "Auto-recharge is only available for Pro, Team, or Custom workspaces",
        };
      }
      if (threshold === undefined || amount === undefined) {
        return {
          ok: false,
          error:
            "threshold and amount are required when enabling auto-recharge",
        };
      }
      if (threshold >= amount) {
        return {
          ok: false,
          error: "threshold must be less than amount to avoid recharge loops",
        };
      }
    }

    await writeDb
      .update(orgMetadata)
      .set({
        autoRechargeEnabled: enabled,
        autoRechargeThreshold: enabled ? threshold : null,
        autoRechargeAmount: enabled ? amount : null,
        ...(!enabled ? { autoRechargePendingAt: null } : {}),
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();

    return {
      ok: true,
      data: {
        enabled,
        threshold: enabled ? (threshold ?? null) : null,
        amount: enabled ? (amount ?? null) : null,
      },
    };
  },
);
