import { createBddApi } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { expect, test } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { billingStatusRoutes } from "../billing-status";
import { webhooksStripeRoutes } from "../webhooks-stripe";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("webhooks-stripe-credit-purchase-001 grants a paid credit invoice once across distinct webhook events", async () => {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_credit_purchase");
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  const orgId = admin.orgId;
  if (!orgId) {
    throw new Error("Expected an organization");
  }
  const appFor = setupApp({
    context,
    routes: [...billingStatusRoutes, ...webhooksStripeRoutes],
  });
  const status = appFor(billingStatusContract);
  const webhook = appFor(webhookStripeContract);
  const readStatus = async () => {
    createRouteMocks(context).clerk.session(admin.userId, orgId, admin.orgRole);
    return (await accept(status.get({ headers }), [200])).body;
  };
  const expiresAt = new Date(now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const invoice = {
    id: `in_credit_${randomUUID().slice(0, 8)}`,
    customer: null,
    subtotal: 10_000,
    metadata: { type: "credit_purchase", orgId, creditsExpiresAt: expiresAt },
    parent: null,
    lines: { has_more: false, data: [] },
  };
  const deliver = async () => {
    const event = {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      created: Math.floor(now() / 1000),
      data: { object: invoice },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    return await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=credit-purchase" },
      }),
      [200],
    );
  };

  const before = await readStatus();
  expect(before).toMatchObject({
    canBuyCredits: true,
    hasSubscription: false,
  });

  await deliver();
  const granted = await readStatus();
  expect(granted.credits).toBe(before.credits + 100_000);
  const added = granted.creditGrants.filter((grant) => {
    return !before.creditGrants.some((previous) => {
      return previous.id === grant.id;
    });
  });
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ amount: 100_000, remaining: 100_000 });
  expect(Date.parse(added[0]?.expiresAt ?? "")).toBe(Date.parse(expiresAt));
  expect(granted.creditGrants).toStrictEqual(
    expect.arrayContaining(before.creditGrants),
  );
  expect({
    tier: granted.tier,
    restrictedBuiltInModels: granted.restrictedBuiltInModels,
    autoRechargeAllowed: granted.autoRechargeAllowed,
  }).toStrictEqual({
    tier: before.tier,
    restrictedBuiltInModels: before.restrictedBuiltInModels,
    autoRechargeAllowed: false,
  });

  await deliver();
  const replayed = await readStatus();
  expect(replayed.credits).toBe(granted.credits);
  expect(replayed.creditGrants).toStrictEqual(granted.creditGrants);
});
