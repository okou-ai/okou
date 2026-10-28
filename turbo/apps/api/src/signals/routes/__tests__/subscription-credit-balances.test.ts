import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meThirdPartySubscriptionsListRoutes } from "../me-model-providers-list";
import { createBddApi } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...meThirdPartySubscriptionsListRoutes,
  ...meModelProviderAccountRoutes,
]);

function app() {
  return setupApp({ context, routes });
}

async function connectedAccounts() {
  const actor = createBddApi(context).user();
  const externalAccounts = [
    { accountId: `credits-${randomUUID()}`, balance: "1250.5000" },
    { accountId: `credits-${randomUUID()}`, balance: "0.0000" },
  ];
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
      const account = externalAccounts.find((candidate) => {
        return (
          candidate.accountId === request.headers.get("chatgpt-account-id")
        );
      });
      if (!account) {
        return new HttpResponse(null, { status: 401 });
      }
      return HttpResponse.json({
        plan_type: "pro",
        credits: {
          has_credits: Number(account.balance) > 0,
          unlimited: false,
          balance: account.balance,
        },
      });
    }),
  );
  const accountIds: string[] = [];
  for (const account of externalAccounts) {
    mockCodexDeviceAuthProvider({ accountId: account.accountId });
    const device = createAuthDeviceApiActions(context);
    const started = await device.requestCodexStart(actor, "personal", [200], {
      mode: "add",
    });
    if (started.status !== 200) {
      throw new Error("Expected device authentication to start");
    }
    const completed = await device.requestCodexComplete(
      actor,
      started.body.sessionToken,
      [200],
    );
    if (!("status" in completed.body) || completed.body.status !== "complete") {
      throw new Error("Expected a connected subscription");
    }
    accountIds.push(completed.body.provider.id);
  }
  const [first, second] = accountIds;
  if (!first || !second) {
    throw new Error("Expected two connected accounts");
  }
  return { actor, first, second };
}

test("lists account-owned live credits within the subscription rollout", async () => {
  const { actor, first, second } = await connectedAccounts();
  const disabled = await accept(
    app()(thirdPartySubscriptionsMainContract).list({ headers }),
    [200],
  );
  expect(disabled.body.subscriptions).toHaveLength(2);
  for (const account of disabled.body.subscriptions) {
    expect(account.planType).toBe("pro");
    expect(account).not.toHaveProperty("subscriptionCredits");
  }

  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.SidebarSubscriptionUsage]: true,
  });
  const listed = await accept(
    app()(thirdPartySubscriptionsMainContract).list({ headers }),
    [200],
  );
  expect(listed.body.subscriptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: first,
        subscriptionCredits: { balance: 1250.5, unlimited: false },
      }),
      expect.objectContaining({
        id: second,
        subscriptionCredits: { balance: 0, unlimited: false },
      }),
    ]),
  );

  await accept(
    app()(personalModelProviderAccountsByIdContract).activate({
      headers,
      params: { id: second },
      body: {},
    }),
    [200],
  );
  const switched = await accept(
    app()(thirdPartySubscriptionsMainContract).list({ headers }),
    [200],
  );
  expect(switched.body.subscriptions[0]).toMatchObject({
    id: second,
    isActive: true,
    subscriptionCredits: { balance: 0, unlimited: false },
  });
});

test.each([
  {
    name: "unknown amount",
    credits: { has_credits: false, unlimited: false, balance: "unavailable" },
    expected: { balance: null, unlimited: false },
  },
  {
    name: "unlimited credits",
    credits: { has_credits: true, unlimited: true, balance: null },
    expected: { balance: null, unlimited: true },
  },
  { name: "unavailable status", credits: null, expected: null },
])("preserves quotas with $name", async ({ credits, expected }) => {
  const { actor } = await connectedAccounts();
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.SidebarSubscriptionUsage]: true,
  });
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({
        plan_type: "pro",
        credits,
        rate_limit_reset_credits: { available_count: 2 },
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: 1_893_441_600,
          },
        },
      });
    }),
  );
  const listed = await accept(
    app()(thirdPartySubscriptionsMainContract).list({ headers }),
    [200],
  );
  for (const account of listed.body.subscriptions) {
    expect(account).toMatchObject({
      subscriptionCredits: expected,
      subscriptionResetCredits: 2,
      subscriptionUsage: {
        fiveHour: { remainingPercent: 75 },
      },
    });
  }
});
