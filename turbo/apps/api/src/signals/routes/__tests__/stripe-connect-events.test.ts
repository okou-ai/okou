import { randomUUID } from "node:crypto";
import { webhookStripeConnectContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { webhooksStripeConnectRoutes } from "../webhooks-stripe-connect";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const api = createBddApi(context);
const connectors = createConnectorBddApi(context);
const WEBHOOK_SECRET = "whsec_stripe_connect_events";
const { default: Stripe } =
  await vi.importActual<typeof import("stripe")>("stripe");
function stripeVerifier() {
  return new Stripe("sk_test_connect_events");
}

async function connectStripeOAuth(
  actor: ApiTestUser,
  accountId: string,
  displayName?: string,
) {
  server.use(
    http.post("https://api.stripe.com/v1/oauth/token", () => {
      return HttpResponse.json({
        access_token: `stripe-access-${randomUUID()}`,
        refresh_token: "stripe-refresh-token",
        stripe_user_id: accountId,
        livemode: true,
        scope: "stripe_apps",
      });
    }),
    http.get("https://api.stripe.com/v1/account", () => {
      return HttpResponse.json({
        id: accountId,
        business_profile: { name: "Stripe Connect Account" },
        email: "stripe-connect@example.test",
      });
    }),
  );
  const started = await connectors.startOauth(
    actor,
    "stripe",
    "oauth",
    undefined,
    displayName === undefined ? undefined : { intent: "add", displayName },
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  await connectors.completeOauthCallback("stripe", {
    code: `stripe-connect-${randomUUID()}`,
    state,
  });
  if (displayName === undefined) {
    return await connectors.readDefaultBuiltinAccount(actor, "stripe");
  }
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "stripe",
  );
  const account = accounts.find((candidate) => {
    return candidate.displayName === displayName;
  });
  if (!account) {
    throw new Error("Expected added Stripe OAuth account");
  }
  return account;
}

function deauthorization(accountId: string) {
  return {
    id: `evt_${randomUUID()}`,
    type: "account.application.deauthorized",
    account: accountId,
    livemode: true,
    created: Math.floor(now() / 1000),
    data: { object: {} },
  };
}

async function postEvent(event: object, signingSecret = WEBHOOK_SECRET) {
  const body = JSON.stringify(event);
  return await setupApp({
    context,
    routes: webhooksStripeConnectRoutes,
  })(webhookStripeConnectContract).post({
    body,
    extraHeaders: {
      "stripe-signature": stripeVerifier().webhooks.generateTestHeaderString({
        payload: body,
        secret: signingSecret,
      }),
    },
  });
}

beforeEach(() => {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_ID", "stripe-client-id");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_SECRET", "sk_test_connect");
  mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", WEBHOOK_SECRET);
  const verifier = stripeVerifier();
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (rawBody, signature, secret) => {
      return verifier.webhooks.constructEventAsync(
        z.string().parse(rawBody),
        z.string().parse(signature),
        z.string().parse(secret),
      );
    },
  );
});

describe("Stripe Connect account notifications", () => {
  it("requires the configured Connect signing secret before changing an account", async () => {
    const actor = api.user();
    const accountId = `acct_stripe_signature_${randomUUID()}`;
    const connected = await connectStripeOAuth(actor, accountId);
    const event = deauthorization(accountId);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_independent");
    expect((await postEvent(event, "whsec_billing_independent")).status).toBe(
      401,
    );

    const unsigned = await setupApp({
      context,
      routes: webhooksStripeConnectRoutes,
    })(webhookStripeConnectContract).post({
      body: JSON.stringify(event),
    });
    expect(unsigned.status).toBe(401);

    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", undefined);
    expect((await postEvent(event)).status).toBe(503);
    await expect(
      connectors.readDefaultBuiltinAccount(actor, "stripe"),
    ).resolves.toStrictEqual(connected);
  });

  it("ignores test-mode and unrelated events", async () => {
    const actor = api.user();
    const accountId = `acct_stripe_validation_${randomUUID()}`;
    const connected = await connectStripeOAuth(actor, accountId);
    const event = deauthorization(accountId);
    for (const ignored of [
      { ...event, livemode: false },
      { ...event, livemode: false, account: undefined },
      { type: "customer.created", account: accountId },
    ]) {
      const response = await postEvent(ignored);
      expect(response.status).toBe(200);
      expect(response.body).toBe("OK");
    }
    await expect(
      connectors.readDefaultBuiltinAccount(actor, "stripe"),
    ).resolves.toStrictEqual(connected);
  });

  it("marks matching OAuth accounts across owners and preserves unrelated connections on repeated notifications", async () => {
    const actor = api.user();
    const sharedOwner = api.user();
    const otherOwner = api.user();
    const accountId = `acct_stripe_revoked_${randomUUID()}`;
    const connected = await connectStripeOAuth(actor, accountId);
    const shared = await connectStripeOAuth(sharedOwner, accountId);
    const unrelated = await connectStripeOAuth(
      otherOwner,
      `acct_stripe_other_${randomUUID()}`,
    );
    const additional = await connectStripeOAuth(
      actor,
      accountId,
      "Shared Stripe",
    );
    const apiToken = await connectors.connectManualGrant(
      actor,
      "stripe",
      "api-token",
      { apiKey: "sk_test_stripe_deauthorization" },
    );
    mockGitHubConnectorOAuth();
    const githubStart = await connectors.startOauth(
      otherOwner,
      "github",
      "oauth",
    );
    const githubState = new URL(githubStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!githubState) {
      throw new Error("Expected GitHub OAuth state");
    }
    await connectors.completeOauthCallback("github", {
      code: `github-deauthorization-${randomUUID()}`,
      state: githubState,
    });
    const github = await connectors.readDefaultBuiltinAccount(
      otherOwner,
      "github",
    );
    const event = deauthorization(accountId);
    for (const receivedAt of [
      "2026-10-08T11:00:00.000Z",
      "2026-10-08T11:01:00.000Z",
    ]) {
      mockNow(Date.parse(receivedAt));
      expect((await postEvent(event)).status).toBe(200);
      for (const [owner, connection] of [
        [actor, connected],
        [sharedOwner, shared],
        [actor, additional],
      ] as const) {
        await expect(
          connectors.readBuiltinConnectorAccount(
            owner,
            "stripe",
            connection.id,
          ),
        ).resolves.toMatchObject({
          connectionStatus: "reconnect-required",
          reconnectReason: "authorization_expired_or_revoked",
          updatedAt: receivedAt,
        });
      }
    }
    await expect(
      connectors.readBuiltinConnectorAccount(actor, "stripe", apiToken.id),
    ).resolves.toStrictEqual(apiToken);
    await expect(
      connectors.readDefaultBuiltinAccount(otherOwner, "stripe"),
    ).resolves.toStrictEqual(unrelated);
    await expect(
      connectors.readDefaultBuiltinAccount(otherOwner, "github"),
    ).resolves.toStrictEqual(github);
  });
});
