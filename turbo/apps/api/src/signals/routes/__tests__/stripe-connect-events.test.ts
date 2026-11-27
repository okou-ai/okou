import { randomUUID } from "node:crypto";
import { webhookStripeConnectContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { webhooksStripeConnectRoutes } from "../webhooks-stripe-connect";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const connectWebhookClient = setupApp({
  context,
  routes: webhooksStripeConnectRoutes,
})(webhookStripeConnectContract);

const CONNECT_SECRET = "whsec_stripe_connect_events";
const BILLING_SECRET = "whsec_stripe_billing_events";

/** Stripe's Marketplace OAuth answers for the account the user authorizes. */
function stripeAuthorizes(accountId: string) {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_ID", "ca_stripe_connect_events");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_SECRET", "sk_stripe_connect_events");
  server.use(
    http.post("https://api.stripe.com/v1/oauth/token", () => {
      return HttpResponse.json({
        access_token: `stripe-access-${randomUUID()}`,
        refresh_token: `stripe-refresh-${randomUUID()}`,
        livemode: true,
        stripe_user_id: accountId,
      });
    }),
    http.get("https://api.stripe.com/v1/account", () => {
      return HttpResponse.json({
        id: accountId,
        email: "owner@example.test",
        business_profile: { name: "Connected shop" },
      });
    }),
  );
}

async function connectStripe(actor: ApiTestUser, accountId: string) {
  stripeAuthorizes(accountId);
  const started = await connectors.startOauth(actor, "stripe", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  const completed = await connectors.completeOauthCallbackResult("stripe", {
    state,
    code: `code-${randomUUID()}`,
  });
  expect(completed.body.status).toBe("success");
}

/** Stripe's SDK verifier accepts only payloads signed with the Connect endpoint secret. */
function stripeSignsWith(secret: string, event: unknown) {
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (_payload: unknown, _signature: unknown, configured: unknown) => {
      if (configured !== secret) {
        throw new Error("No signatures found matching the expected signature");
      }
      return Promise.resolve(event);
    },
  );
}

function deauthorization(accountId: string) {
  return {
    id: `evt_${randomUUID()}`,
    type: "account.application.deauthorized",
    account: accountId,
    livemode: true,
    created: Math.floor(now() / 1000),
    data: { object: { id: `ca_${randomUUID()}` } },
  };
}

function stripeAccountId() {
  return `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function postConnectEvent(
  event: unknown,
  headers: Record<string, string>,
  statuses: readonly (200 | 401 | 503)[],
) {
  return accept(
    connectWebhookClient.post({
      body: JSON.stringify(event),
      extraHeaders: headers,
    }),
    statuses,
  );
}

describe("Stripe Connect account notifications", () => {
  it("stripe-connect-events-001 requires the configured Connect signing secret before changing an account", async () => {
    const owner = bdd.user();
    const accountId = stripeAccountId();
    await connectStripe(owner, accountId);
    const before = await connectors.readDefaultBuiltinAccount(owner, "stripe");
    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", CONNECT_SECRET);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", BILLING_SECRET);
    const event = deauthorization(accountId);
    stripeSignsWith(BILLING_SECRET, event);

    await Promise.all([
      postConnectEvent(
        event,
        { "stripe-signature": "t=1,v1=signed-with-billing-secret" },
        [401],
      ),
      postConnectEvent(event, {}, [401]),
    ]);
    stripeSignsWith(CONNECT_SECRET, event);
    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", undefined);
    await postConnectEvent(
      event,
      { "stripe-signature": "t=1,v1=signed-with-connect-secret" },
      [503],
    );

    const after = await connectors.readDefaultBuiltinAccount(owner, "stripe");
    expect(after).toStrictEqual(before);
    expect(after).toMatchObject({
      externalId: accountId,
      connectionStatus: "connected",
      reconnectReason: null,
    });
  });
});
