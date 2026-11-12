import type { BillingSurveyCheckoutKind } from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { now } from "../../lib/time";
import { db$ } from "../external/db";
import {
  getStripeClient,
  isStripeResourceMissingError,
  type StripeCheckoutSession,
} from "../external/stripe-client";
import { settle } from "../utils";
import { isCurrentStripePreviewMetadata } from "./stripe-preview-metadata.service";

const CHECKOUT_GRACE_MS = 30 * 60 * 1000;
const CHECKOUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface SurveyIdentity {
  readonly orgId: string;
  readonly userId: string;
}

function checkoutKind(
  session: StripeCheckoutSession,
): BillingSurveyCheckoutKind | null {
  if (session.metadata?.purpose === "credit_purchase") {
    return "credits";
  }
  if (session.metadata?.usagePackSubscriptionId) {
    return "usage_pack";
  }
  return session.mode === "subscription" &&
    (session.metadata?.tier === "pro" || session.metadata?.tier === "team")
    ? "plan"
    : null;
}

function ownedCheckout(
  session: StripeCheckoutSession,
  identity: SurveyIdentity,
  customerId: string,
): boolean {
  const customer =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  return (
    customer === customerId &&
    session.metadata?.orgId === identity.orgId &&
    session.metadata.billingSurveyUserId === identity.userId &&
    isCurrentStripePreviewMetadata(session.metadata) &&
    checkoutKind(session) !== null
  );
}

function unpaidCheckout(session: StripeCheckoutSession): boolean {
  const age = now() - (session.created ?? 0) * 1000;
  return (
    age >= 0 &&
    age < CHECKOUT_MAX_AGE_MS &&
    (session.status === "open" || session.status === "expired") &&
    session.payment_status === "unpaid" &&
    session.metadata?.billingSurveyDismissed !== "true"
  );
}

const surveyStripeCustomer$ = command(
  async ({ get }, orgId: string, signal: AbortSignal) => {
    const [org] = await get(db$)
      .select({ customerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    return org?.customerId ?? null;
  },
);

/** Stripe owns payment status and creation time; no browser marker is needed. */
export const abandonedBillingCheckout$ = command(
  async (
    { set },
    args: SurveyIdentity & { readonly returnedFromCheckout: boolean },
    signal: AbortSignal,
  ) => {
    const customerId = await set(surveyStripeCustomer$, args.orgId, signal);
    if (!customerId) {
      return null;
    }
    const stripe = getStripeClient();
    let startingAfter: string | undefined;
    while (true) {
      const page = await stripe.checkout.sessions.list({
        customer: customerId,
        created: { gte: Math.floor((now() - CHECKOUT_MAX_AGE_MS) / 1000) },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      signal.throwIfAborted();
      const latest = page.data.find((session) => {
        return ownedCheckout(session, args, customerId);
      });
      if (latest) {
        // A newer completed or dismissed purchase suppresses older unpaid ones.
        if (
          !unpaidCheckout(latest) ||
          (!args.returnedFromCheckout &&
            now() - (latest.created ?? 0) * 1000 < CHECKOUT_GRACE_MS)
        ) {
          return null;
        }
        const kind = checkoutKind(latest);
        if (!kind) {
          return null;
        }
        return { checkoutSessionId: latest.id, checkoutKind: kind };
      }
      if (!page.has_more) {
        return null;
      }
      const last = page.data.at(-1);
      if (!last || last.id === startingAfter) {
        throw new Error("Stripe returned an invalid Checkout page cursor");
      }
      startingAfter = last.id;
    }
  },
);

export const ownedUnpaidBillingCheckout$ = command(
  async (
    { set },
    args: SurveyIdentity & { readonly sessionId: string },
    signal: AbortSignal,
  ) => {
    const customerId = await set(surveyStripeCustomer$, args.orgId, signal);
    if (!customerId) {
      return null;
    }
    const result = await settle(
      getStripeClient().checkout.sessions.retrieve(args.sessionId),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isStripeResourceMissingError(result.error)) {
        return null;
      }
      throw result.error;
    }
    return ownedCheckout(result.value, args, customerId) &&
      unpaidCheckout(result.value)
      ? checkoutKind(result.value)
      : null;
  },
);

/** A dismissal belongs to this Checkout, not to the member's final answer. */
export const dismissBillingCheckoutSurvey$ = command(
  async (
    { set },
    args: SurveyIdentity & { readonly sessionId: string },
    signal: AbortSignal,
  ) => {
    const checkout = await set(ownedUnpaidBillingCheckout$, args, signal);
    if (!checkout) {
      return;
    }
    await getStripeClient().checkout.sessions.update(args.sessionId, {
      metadata: { billingSurveyDismissed: "true" },
    });
    signal.throwIfAborted();
  },
);
