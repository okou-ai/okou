import { billingUsagePackCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { randomUUID } from "node:crypto";
import type StripeSDK from "stripe";
import { expect } from "vitest";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { mockStripeClient } from "../../../external/stripe-client";
import { billingCheckoutRoutes } from "../../billing-checkout";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { createRouteMocks } from "./route-test";

const selectionSchema = z.object({
  metadata: z
    .object({ usagePackSubscriptionId: z.string() })
    .catchall(z.string()),
});
const PRICE_PLAN = "price_public_usage_plan";
const PRICE_20 = "price_public_usage_20";
const PRICE_50 = "price_public_usage_50";
const PRICE_100 = "price_public_usage_100";
const PRICE_200 = "price_public_usage_200";
const STRIPE_CATALOG = [
  { id: PRICE_20, usd: 20, bonusCredits: 400 },
  { id: PRICE_50, usd: 50, bonusCredits: 2600 },
  { id: PRICE_100, usd: 100, bonusCredits: 8700 },
  { id: PRICE_200, usd: 200, bonusCredits: 22_200 },
] as const;

/** Purchase allocations through checkout; Stripe receives the application metadata. */
export async function purchaseUsagePacks(
  context: TestContext,
  actor: { readonly userId: string; readonly orgId: string },
  selections: readonly { readonly userId: string; readonly usd: 20 | 50 }[],
): Promise<void> {
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockOptionalEnv("STRIPE_SECRET_KEY", "sk_public_usage_pack");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_public_usage_pack");
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", PRICE_PLAN);
  mockEnv("OKOU_PRICE_USAGE_PACK_20", PRICE_20);
  mockEnv("OKOU_PRICE_USAGE_PACK_50", PRICE_50);
  mockEnv("OKOU_PRICE_USAGE_PACK_100", PRICE_100);
  mockEnv("OKOU_PRICE_USAGE_PACK_200", PRICE_200);
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  const members = [
    ...new Set([
      actor.userId,
      ...selections.map((s) => {
        return s.userId;
      }),
    ]),
  ];
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: actor.orgId,
    name: "Public usage pack",
    slug: `pack-${randomUUID()}`,
    createdBy: actor.userId,
    createdAt: now(),
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: members.map((userId) => {
        return {
          role: userId === actor.userId ? "org:admin" : "org:member",
          publicUserData: { userId },
          createdAt: now(),
        };
      }),
    },
  );
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
  const customerId = `cus_${randomUUID()}`;
  const sessionId = `cs_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValueOnce({
    id: customerId,
  });
  let checkoutMetadata: z.infer<typeof selectionSchema>["metadata"] | undefined;
  context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
    (input) => {
      checkoutMetadata = selectionSchema.parse(input).metadata;
      return Promise.resolve({
        id: sessionId,
        url: `https://checkout.stripe.test/${sessionId}`,
      });
    },
  );
  context.mocks.stripe.prices.retrieve.mockImplementation((id) => {
    const price = STRIPE_CATALOG.find((item) => {
      return item.id === id;
    });
    if (!price) {
      throw new Error(`Unexpected purchase price ${String(id)}`);
    }
    const { usd, bonusCredits } = price;
    return Promise.resolve({
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: usd * 100,
      tax_behavior: "exclusive",
      product: {
        id: `prod_${usd}`,
        name: `Usage ${usd}`,
        metadata: { bonusCredits: String(bonusCredits) },
        tax_code: "txcd_10000000",
      },
    });
  });
  const origin = new URL(env("APP_URL")).origin;
  const checkout = await accept(
    setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    ).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tier: "pro",
        memberUsagePacks: selections.map((s) => {
          return {
            memberId: s.userId,
            usagePackUsd: s.usd,
          };
        }),
        successUrl: `${origin}/billing`,
        cancelUrl: `${origin}/billing`,
      },
    }),
    [200],
  );
  expect(checkout.body).toStrictEqual({
    url: `https://checkout.stripe.test/${sessionId}`,
  });
  if (!checkoutMetadata) {
    throw new Error("Stripe checkout did not receive allocation metadata");
  }
  const metadata = checkoutMetadata;
  const start = Math.floor(now() / 1000);
  const end = start + 30 * 86_400;
  const quantities = [20, 50]
    .map((usd) => {
      return {
        usd,
        quantity: selections.filter((s) => {
          return s.usd === usd;
        }).length,
      };
    })
    .filter((s) => {
      return s.quantity > 0;
    });
  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    trial_end: null,
    metadata,
    items: {
      data: [
        {
          price: { id: PRICE_PLAN },
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
        },
        ...quantities.map(({ usd, quantity }) => {
          return {
            price: { id: usd === 20 ? PRICE_20 : PRICE_50 },
            quantity,
            current_period_start: start,
            current_period_end: end,
          };
        }),
      ],
    },
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  const event = {
    id: `evt_${randomUUID()}`,
    type: "invoice.paid",
    created: start,
    data: {
      object: {
        id: `in_${randomUUID()}`,
        customer: customerId,
        metadata,
        status: "paid",
        paid: true,
        parent: {
          subscription_details: { subscription: subscriptionId, metadata },
        },
        lines: {
          has_more: false,
          data: quantities.map(({ usd, quantity }) => {
            return {
              id: `il_${randomUUID()}`,
              amount: usd * 100 * quantity,
              subtotal: usd * 100 * quantity,
              discount_amounts: [],
              quantity,
              price: { id: usd === 20 ? PRICE_20 : PRICE_50 },
              period: { start, end },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            };
          }),
        },
      },
    },
  };
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    ).post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=public-usage-pack" },
    }),
    [200],
  );
}
