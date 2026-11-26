import { randomUUID } from "node:crypto";

import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
  personalSubscriptionsContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meThirdPartySubscriptionsListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const deviceAuth = createAuthDeviceApiActions(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [
    ...meModelProviderAccountRoutes,
    ...meThirdPartySubscriptionsListRoutes,
    ...meModelProvidersUpsertRoutes,
  ],
});
const subscriptions = app(thirdPartySubscriptionsMainContract);
const subscription = app(personalSubscriptionsContract);
const accounts = app(personalModelProviderAccountsByIdContract);
const providers = app(personalModelProvidersMainContract);

const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

function user(overrides: Partial<ApiTestUser> = {}): ApiTestUser {
  const userId = overrides.userId ?? `user_${randomUUID()}`;
  return {
    userId,
    orgId: overrides.orgId ?? `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
}

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

function chatgptUsage(fiveHourUsed: number, weeklyUsed: number): void {
  const resetAt = Math.floor(now() / 1000) + 3600;
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: fiveHourUsed,
            limit_window_seconds: FIVE_HOURS,
            reset_at: resetAt,
          },
          secondary_window: {
            used_percent: weeklyUsed,
            limit_window_seconds: WEEK,
            reset_at: resetAt + 2 * 86_400,
          },
        },
      });
    }),
  );
}

function chatgptUsageWithResetCredits(available: number): void {
  const resetAt = Math.floor(now() / 1000) + 3600;
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 75,
            limit_window_seconds: FIVE_HOURS,
            reset_at: resetAt,
          },
          secondary_window: {
            used_percent: 40,
            limit_window_seconds: WEEK,
            reset_at: resetAt + 2 * 86_400,
          },
        },
        rate_limit_reset_credits: { available_count: available },
      });
    }),
    http.get(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      () => {
        return HttpResponse.json({
          credits: Array.from({ length: available }, () => {
            return { status: "available", expires_at: null };
          }),
        });
      },
    ),
  );
}

function anthropic(usage: () => Response): void {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json({});
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return usage();
    }),
  );
}

function claudeUsage(fiveHourUsed: number, weeklyUsed: number): Response {
  return HttpResponse.json({
    five_hour: {
      utilization: fiveHourUsed,
      resets_at: new Date(now() + 3_600_000).toISOString(),
    },
    seven_day: {
      utilization: weeklyUsed,
      resets_at: new Date(now() + 3 * 86_400_000).toISOString(),
    },
  });
}

/** Connect one Codex subscription through ChatGPT device authorization. */
async function connectCodex(actor: ApiTestUser, accountId: string) {
  mockCodexDeviceAuthProvider({
    accountId,
    workspaceName: `Workspace ${accountId}`,
    refreshToken: `rt_${accountId}_synthetic_high_entropy`,
  });
  const started = await deviceAuth.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected a started Codex sign-in");
  }
  const completed = await deviceAuth.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected a completed Codex sign-in");
  }
  return completed.body.provider;
}

async function connectClaude(actor: ApiTestUser) {
  signIn(actor);
  return await accept(
    providers.upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat01-${randomUUID()}`,
      },
    }),
    [201],
  );
}

async function listSubscriptions(actor: ApiTestUser) {
  signIn(actor);
  const listed = await accept(subscriptions.list({ headers }), [200]);
  return listed.body.subscriptions;
}

async function ownerWithTwoCodexSubscriptions() {
  chatgptUsage(10, 20);
  const owner = user();
  const owned = await connectCodex(owner, `acct_${randomUUID()}`);
  await connectCodex(owner, `acct_${randomUUID()}`);
  return { owner, owned };
}

/** What another user observes about the owner's account and a random ID. */
async function observeAsOther(other: ApiTestUser, ownedId: string) {
  const list = await listSubscriptions(other);
  signIn(other);
  const read = async (id: string) => {
    const response = await accept(
      subscription.get({ headers, params: { id } }),
      [404],
    );
    return response.body;
  };
  const activate = async (id: string) => {
    const response = await accept(
      accounts.activate({ headers, params: { id }, body: {} }),
      [404],
    );
    return response.body;
  };
  return {
    list,
    ownedRead: await read(ownedId),
    randomRead: await read(randomUUID()),
    ownedActivation: await activate(ownedId),
    randomActivation: await activate(randomUUID()),
  };
}

describe("personal subscription controls", () => {
  it("subscription-controls-009 shows Claude Code usage windows but refuses a manual reset", async () => {
    anthropic(() => {
      return claudeUsage(12, 24);
    });
    const member = user();
    const connected = await connectClaude(member);

    signIn(member);
    const detail = await accept(
      subscription.get({ headers, params: { id: connected.body.provider.id } }),
      [200],
    );
    expect(detail.body.subscriptionResetSupported).toBeFalsy();
    expect(detail.body.subscriptionUsage).toMatchObject({
      fiveHour: { remainingPercent: 88 },
      weekly: { remainingPercent: 76 },
    });
    await accept(
      accounts.resetSubscriptionUsage({
        headers,
        params: { id: connected.body.provider.id },
        body: { idempotencyKey: randomUUID() },
      }),
      [404],
    );
  });

  it("subscription-controls-006 (1/2) hides a member's subscriptions from a colleague in the same organization", async () => {
    const { owner, owned } = await ownerWithTwoCodexSubscriptions();

    const seen = await observeAsOther(user({ orgId: owner.orgId }), owned.id);
    expect(seen.list).toStrictEqual([]);
    expect(seen.ownedRead).toStrictEqual(seen.randomRead);
    expect(seen.ownedActivation).toStrictEqual(seen.randomActivation);
  });

  it("subscription-controls-006 (2/2) hides a member's subscriptions from the same user in another organization", async () => {
    const { owner, owned } = await ownerWithTwoCodexSubscriptions();

    const seen = await observeAsOther(user({ userId: owner.userId }), owned.id);
    expect(seen.list).toStrictEqual([]);
    expect(seen.ownedRead).toStrictEqual(seen.randomRead);
    expect(seen.ownedActivation).toStrictEqual(seen.randomActivation);
  });

  it("subscription-controls-010 keeps Codex usage when Claude Code usage becomes unavailable", async () => {
    chatgptUsage(75, 40);
    let claudeAvailable = true;
    anthropic(() => {
      return claudeAvailable
        ? claudeUsage(12, 24)
        : HttpResponse.json({ error: "unavailable" }, { status: 503 });
    });
    const member = user();
    await connectCodex(member, `acct_${randomUUID()}`);
    await connectCodex(member, `acct_${randomUUID()}`);
    await connectClaude(member);

    const first = await listSubscriptions(member);
    expect(first).toHaveLength(3);
    const codex = first.filter((entry) => {
      return entry.type === "codex-oauth-token";
    });
    expect(codex).toHaveLength(2);
    for (const entry of codex) {
      expect(entry.subscriptionUsage).toMatchObject({
        fiveHour: { usedPercent: 75 },
        weekly: { usedPercent: 40 },
      });
    }
    const claude = first.find((entry) => {
      return entry.type === "claude-code-oauth-token";
    });
    expect(claude?.subscriptionUsage).toMatchObject({
      fiveHour: { usedPercent: 12 },
      weekly: { usedPercent: 24 },
    });

    claudeAvailable = false;
    const second = await listSubscriptions(member);
    expect(
      second.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual(
      first.map((entry) => {
        return entry.id;
      }),
    );
    expect(
      second.filter((entry) => {
        return entry.type === "codex-oauth-token";
      }),
    ).toStrictEqual(codex);
    const unavailable = second.find((entry) => {
      return entry.id === claude?.id;
    });
    expect(unavailable).toMatchObject({
      type: "claude-code-oauth-token",
      needsReconnect: false,
    });
    expect(unavailable?.subscriptionUsage ?? null).toBeNull();
  });

  it("subscription-controls-007 rejects resets of foreign, logical-provider and disconnected IDs without changing the remaining account", async () => {
    chatgptUsageWithResetCredits(3);
    const owner = user();
    const kept = await connectCodex(owner, `acct_${randomUUID()}`);
    const removed = await connectCodex(owner, `acct_${randomUUID()}`);
    const original = (await listSubscriptions(owner)).find((entry) => {
      return entry.id === kept.id;
    });
    if (!original?.modelProviderId) {
      throw new Error("Expected the kept account's logical provider ID");
    }
    signIn(owner);
    await accept(
      accounts.delete({ headers, params: { id: removed.id } }),
      [204],
    );

    const reset = async (actor: ApiTestUser, id: string) => {
      signIn(actor);
      const response = await accept(
        accounts.resetSubscriptionUsage({
          headers,
          params: { id },
          body: { idempotencyKey: randomUUID() },
        }),
        [404],
      );
      return response.body;
    };
    const notFound = {
      error: { message: "Resource not found", code: "NOT_FOUND" },
    };
    await expect(reset(owner, randomUUID())).resolves.toStrictEqual(notFound);
    await expect(reset(owner, original.modelProviderId)).resolves.toStrictEqual(
      notFound,
    );
    await expect(reset(owner, removed.id)).resolves.toStrictEqual(notFound);
    await expect(
      reset(user({ orgId: owner.orgId }), kept.id),
    ).resolves.toStrictEqual(notFound);
    await expect(
      reset(user({ userId: owner.userId }), kept.id),
    ).resolves.toStrictEqual(notFound);

    const remaining = await listSubscriptions(owner);
    expect(remaining).toHaveLength(1);
    expect(original.subscriptionResetCredits).toBe(3);
    expect(remaining[0]).toMatchObject({
      id: kept.id,
      isActive: true,
      modelProviderId: original.modelProviderId,
      subscriptionResetCredits: original.subscriptionResetCredits,
      subscriptionUsage: original.subscriptionUsage,
    });
  });
});
