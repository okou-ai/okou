import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  personalSubscriptionsContract,
  personalModelProvidersMainContract,
  personalModelProviderAccountsByIdContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";

const context = testContext();
const mocks = createRouteMocks(context);
const support = createAuthDeviceSupportApi(context);
const routes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
  ...meModelProviderAccountRoutes,
]);
const app = () => {
  return setupApp({ context, routes });
};
const humanHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

async function fixture() {
  const actor = createBddApi(context).user();
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.SubscriptionControls]: true,
  });
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            reset_at: 1_893_441_600,
            used_percent: 75,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            reset_at: 1_893_456_000,
            used_percent: 40,
          },
        },
        rate_limit_reset_credits: { available_count: 3 },
      });
    }),
  );
  const accountIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: `account-${randomUUID()}`,
      workspaceName: `Workspace ${index}`,
    });
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
  const [firstAccountId, secondAccountId] = accountIds;
  if (!firstAccountId || !secondAccountId) {
    throw new Error("Expected two connected subscriptions");
  }
  return { actor, accountIds: [firstAccountId, secondAccountId] as const };
}

function agentHeaders(actor: ApiTestUser, capabilities: readonly Capability[]) {
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  mockClerkMembership(context, actor, "org:member");
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    capabilities: [...capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
  return { authorization: `Bearer ${token}` };
}

function human(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return humanHeaders;
}

test("agents read all subscriptions and single-account live usage without a failed run", async () => {
  const { actor, accountIds } = await fixture();
  const headers = agentHeaders(actor, ["subscription:read"]);
  const listed = await accept(
    app()(personalModelProvidersMainContract).list({ headers }),
    [200],
  );
  expect(
    listed.body.modelProviders
      .map((account) => {
        return account.id;
      })
      .sort(),
  ).toStrictEqual([...accountIds].sort());
  const detail = await accept(
    app()(personalSubscriptionsContract).get({
      headers,
      params: { id: accountIds[0] },
    }),
    [200],
  );
  expect(detail.body).toMatchObject({
    id: accountIds[0],
    subscriptionResetSupported: true,
    subscriptionResetCredits: 3,
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 75,
        remainingPercent: 25,
        resetAt: "2029-12-31T20:00:00.000Z",
      },
      weekly: { remainingPercent: 60 },
    },
  });
  expect(detail.body).not.toHaveProperty("secrets");
});

test("cLI account activation reuses the existing switch behavior", async () => {
  const { actor, accountIds } = await fixture();
  const headers = agentHeaders(actor, [
    "subscription:read",
    "subscription:switch",
  ]);
  const switched = await accept(
    app()(personalModelProviderAccountsByIdContract).activate({
      headers,
      params: { id: accountIds[1] },
      body: {},
    }),
    [200],
  );
  expect(switched.body).toMatchObject({ id: accountIds[1], isActive: true });
  const listed = await accept(
    app()(personalModelProvidersMainContract).list({ headers }),
    [200],
  );
  expect(
    listed.body.modelProviders.find((account) => {
      return account.id === accountIds[0];
    })?.isActive,
  ).toBeFalsy();
  expect(
    listed.body.modelProviders.find((account) => {
      return account.id === accountIds[1];
    })?.isActive,
  ).toBeTruthy();
});

test("read capability cannot switch, and even a switching agent cannot execute reset", async () => {
  const { actor, accountIds } = await fixture();
  const readHeaders = agentHeaders(actor, ["subscription:read"]);
  expect(
    (
      await app()(personalModelProviderAccountsByIdContract).activate({
        headers: readHeaders,
        params: { id: accountIds[0] },
        body: {},
      })
    ).status,
  ).toBe(403);
  let consumed = false;
  server.use(
    http.post(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      () => {
        consumed = true;
        return HttpResponse.json({ code: "reset", windows_reset: 1 });
      },
    ),
  );
  const headers = agentHeaders(actor, [
    "subscription:read",
    "subscription:switch",
  ]);
  const denied = await accept(
    app()(personalModelProviderAccountsByIdContract).resetSubscriptionUsage({
      headers,
      params: { id: accountIds[0] },
      body: { idempotencyKey: randomUUID() },
    }),
    [403],
  );
  expect(denied.status).toBe(403);
  const listed = await accept(
    app()(personalModelProvidersMainContract).list({ headers }),
    [200],
  );
  expect(
    listed.body.modelProviders.find((account) => {
      return account.id === accountIds[0];
    })?.subscriptionResetCredits,
  ).toBe(3);
  expect(consumed).toBeFalsy();
});

test("foreign users and organizations cannot read or activate the linked account", async () => {
  const { actor, accountIds } = await fixture();
  for (const other of [
    createBddApi(context).user({ orgId: actor.orgId }),
    createBddApi(context).user({ userId: actor.userId }),
  ]) {
    await support.updateFeatureSwitches(other, {
      [FeatureSwitchKey.SubscriptionControls]: true,
    });
    const headers = human(other);
    const existing = await accept(
      app()(personalSubscriptionsContract).get({
        headers,
        params: { id: accountIds[0] },
      }),
      [404],
    );
    const missing = await accept(
      app()(personalSubscriptionsContract).get({
        headers,
        params: { id: randomUUID() },
      }),
      [404],
    );
    expect(existing.body).toStrictEqual(missing.body);
    const activated = await accept(
      app()(personalModelProviderAccountsByIdContract).activate({
        headers,
        params: { id: accountIds[0] },
        body: {},
      }),
      [404],
    );
    expect(activated.status).toBe(404);
  }
});

test("disabling rollout blocks new agent access without changing the existing human settings API", async () => {
  const { actor, accountIds } = await fixture();
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.SubscriptionControls]: false,
  });
  const headers = agentHeaders(actor, [
    "subscription:read",
    "subscription:switch",
  ]);
  const list = await accept(
    app()(personalModelProvidersMainContract).list({ headers }),
    [404],
  );
  expect(list.status).toBe(404);
  const detail = await accept(
    app()(personalSubscriptionsContract).get({
      headers,
      params: { id: accountIds[0] },
    }),
    [404],
  );
  expect(detail.status).toBe(404);
  const switchResult = await accept(
    app()(personalModelProviderAccountsByIdContract).activate({
      headers,
      params: { id: accountIds[1] },
      body: {},
    }),
    [404],
  );
  expect(switchResult.status).toBe(404);
  const legacy = await accept(
    app()(personalModelProvidersMainContract).list({ headers: human(actor) }),
    [200],
  );
  expect(legacy.body.modelProviders).toHaveLength(2);
});

test("an unavailable upstream usage read keeps quota unknown instead of fabricating zero", async () => {
  const { actor, accountIds } = await fixture();
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    }),
  );
  const detail = await accept(
    app()(personalSubscriptionsContract).get({
      headers: human(actor),
      params: { id: accountIds[0] },
    }),
    [200],
  );
  expect(detail.body.id).toBe(accountIds[0]);
  expect(detail.body.subscriptionResetSupported).toBeTruthy();
  expect(detail.body.subscriptionUsage ?? null).toBeNull();
  expect(detail.body.subscriptionResetCredits ?? null).toBeNull();
});

test("claude Code exposes natural usage windows but explicitly rejects manual reset", async () => {
  const actor = createBddApi(context).user();
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.SubscriptionControls]: true,
  });
  mockClaudeCodeTokenEndpoint({
    accountEmail: actor.email,
    organizationName: `Workspace ${randomUUID()}`,
  });
  const connected = await accept(
    app()(personalModelProvidersMainContract).upsert({
      headers: human(actor),
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat-${randomUUID()}`,
      },
    }),
    [201],
  );
  const detail = await accept(
    app()(personalSubscriptionsContract).get({
      headers: human(actor),
      params: { id: connected.body.provider.id },
    }),
    [200],
  );
  expect(detail.body).toMatchObject({
    subscriptionResetSupported: false,
    subscriptionUsage: {
      fiveHour: { remainingPercent: 88 },
      weekly: { remainingPercent: 76 },
    },
  });
  const reset = await accept(
    app()(personalModelProviderAccountsByIdContract).resetSubscriptionUsage({
      headers: human(actor),
      params: { id: connected.body.provider.id },
      body: { idempotencyKey: randomUUID() },
    }),
    [404],
  );
  expect(reset.status).toBe(404);
});

test("a subscription reset link does not grant unauthenticated access", async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const response = await accept(
    app()(personalSubscriptionsContract).get({
      params: { id: randomUUID() },
      headers: {},
    }),
    [401],
  );
  expect(response.status).toBe(401);
});
