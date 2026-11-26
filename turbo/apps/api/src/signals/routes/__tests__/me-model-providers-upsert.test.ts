import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProvidersResetSubscriptionRoutes } from "../me-model-providers-reset-subscription";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { createRouteMocks } from "./helpers/route-test";
import {
  createCodexExpiryFixture,
  credentials,
  detailsUrl,
  headers,
  jwt,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const mocks = createRouteMocks(context);
const codexFixture = createCodexExpiryFixture(context);
const routes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";
const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

interface CodexProvider {
  usageTokens: (string | null)[];
  usageAccounts: (string | null)[];
  refreshTokens: unknown[];
  consumed: {
    bearer: string | null;
    accountId: string | null;
    body: unknown;
  }[];
}

function codexProvider(options: {
  usage?: (call: number) => Response;
  refresh?: () => Response;
}): CodexProvider {
  const seen: CodexProvider = {
    usageTokens: [],
    usageAccounts: [],
    refreshTokens: [],
    consumed: [],
  };
  server.use(
    http.get(CODEX_USAGE_URL, ({ request }) => {
      seen.usageTokens.push(request.headers.get("authorization"));
      seen.usageAccounts.push(request.headers.get("chatgpt-account-id"));
      return options.usage
        ? options.usage(seen.usageTokens.length)
        : HttpResponse.json({ plan_type: "pro" });
    }),
    http.post(CODEX_REFRESH_URL, async ({ request }) => {
      const body = (await request.json()) as { refresh_token?: unknown };
      seen.refreshTokens.push(body.refresh_token);
      return options.refresh
        ? options.refresh()
        : HttpResponse.json({ error: "unexpected" }, { status: 500 });
    }),
    http.post(CODEX_CONSUME_URL, async ({ request }) => {
      seen.consumed.push({
        bearer: request.headers.get("authorization"),
        accountId: request.headers.get("chatgpt-account-id"),
        body: await request.json(),
      });
      return HttpResponse.json({ code: "reset", windows_reset: 1 });
    }),
  );
  return seen;
}

function usageBody() {
  const fiveHourReset = Math.floor(now() / 1000) + 3600;
  const weeklyReset = Math.floor(now() / 1000) + 3 * 24 * 3600;
  return {
    fiveHourReset,
    weeklyReset,
    body: {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: FIVE_HOURS,
          reset_at: fiveHourReset,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: WEEK,
          reset_at: weeklyReset,
        },
      },
    },
  };
}

function expiredCredentials() {
  return credentials(
    randomUUID(),
    jwt({ exp: Math.floor(now() / 1000) - 3600, jti: randomUUID() }),
  );
}

function freshTokens() {
  const accessToken = jwt({
    exp: Math.floor(now() / 1000) + 3600,
    jti: randomUUID(),
  });
  return {
    accessToken,
    response: () => {
      return HttpResponse.json({
        access_token: accessToken,
        refresh_token: `rotated-${randomUUID()}`,
        expires_in: 3600,
      });
    },
  };
}

function storedRefreshToken(auth: ReturnType<typeof credentials>) {
  const parsed = JSON.parse(auth.raw) as { tokens: { refresh_token: string } };
  return parsed.tokens.refresh_token;
}

async function importCodex(raw: string) {
  const client = member();
  const created = await client.upsert({
    headers,
    body: {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: { CODEX_AUTH_JSON: raw },
    },
  });
  const list = async () => {
    const result = await accept(client.list({ headers }), [200]);
    return result.body.modelProviders;
  };
  return { created: await accept(Promise.resolve(created), [201]), list };
}

async function resetByType(idempotencyKey: string) {
  return await setupApp({
    context,
    routes: meModelProvidersResetSubscriptionRoutes,
  })(personalModelProvidersByTypeContract).resetSubscriptionUsage({
    headers,
    params: { type: "codex-oauth-token" },
    body: { idempotencyKey },
  });
}

function member() {
  const userId = `user_upsert_${randomUUID()}`;
  const orgId = `org_upsert_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  return setupApp({ context, routes })(personalModelProvidersMainContract);
}

function claudeProfile(profile: Record<string, unknown>) {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json(profile);
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
}

function codexAuthJson(tokens: Record<string, unknown>) {
  return JSON.stringify({ tokens });
}

test("me-model-providers-upsert-003 creates a personal Claude Code OAuth provider", async () => {
  claudeProfile({});
  const client = member();

  const result = await accept(
    client.upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat01-${randomUUID()}`,
      },
    }),
    [201],
  );

  expect(result.body).toMatchObject({
    created: true,
    provider: { type: "claude-code-oauth-token", framework: "claude-code" },
  });
});

test("me-model-providers-upsert-004 shows a Claude Max 5x account as plan max", async () => {
  claudeProfile({
    account: { uuid: randomUUID(), email: "max@example.com" },
    organization: {
      uuid: randomUUID(),
      name: "Max Workspace",
      organization_type: "claude_max",
      rate_limit_tier: "default_claude_max_5x",
    },
  });
  const client = member();

  const created = await accept(
    client.upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat01-${randomUUID()}`,
      },
    }),
    [201],
  );
  const listed = await accept(client.list({ headers }), [200]);

  expect(created.body.provider.planType).toBe("max");
  expect(listed.body.modelProviders).toHaveLength(1);
  expect(listed.body.modelProviders[0]?.planType).toBe("max");
});

test("me-model-providers-upsert-006 reuses a legacy Claude account after recovering its uuid identity", async () => {
  const legacySecret = `sk-ant-oat01-${randomUUID()}`;
  const replacementSecret = `sk-ant-oat01-${randomUUID()}`;
  const accountUuid = randomUUID();
  const organizationUuid = randomUUID();
  let profileAvailable = false;
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
      if (!profileAvailable) {
        return HttpResponse.json({ error: "unavailable" }, { status: 503 });
      }
      const legacy =
        request.headers.get("authorization") === `Bearer ${legacySecret}`;
      return HttpResponse.json({
        account: {
          uuid: accountUuid,
          email: legacy ? "old-name@example.com" : "claude@example.com",
          has_claude_pro: true,
        },
        organization: {
          uuid: organizationUuid,
          name: legacy ? "Old Workspace" : "Recovered Workspace",
          organization_type: "claude_pro",
        },
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
  const client = member();
  mockNow(Date.parse("2026-03-01T00:00:00.000Z"));
  const legacy = await accept(
    client.upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: legacySecret },
    }),
    [201],
  );
  expect(legacy.body.provider).toMatchObject({
    accountEmail: null,
    workspaceName: null,
  });

  profileAvailable = true;
  mockNow(Date.parse("2026-03-02T00:00:00.000Z"));
  const replaced = await accept(
    client.upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: replacementSecret },
    }),
    [200],
  );
  const listed = await accept(client.list({ headers }), [200]);

  expect(replaced.body.created).toBeFalsy();
  expect(replaced.body.provider).toMatchObject({
    id: legacy.body.provider.id,
    modelProviderId: legacy.body.provider.modelProviderId,
    createdAt: legacy.body.provider.createdAt,
    updatedAt: "2026-03-02T00:00:00.000Z",
    accountEmail: "claude@example.com",
    workspaceName: "Recovered Workspace",
    planType: "pro",
    isActive: true,
  });
  expect(
    listed.body.modelProviders.map(({ id, accountEmail }) => {
      return { id, accountEmail };
    }),
  ).toStrictEqual([
    { id: legacy.body.provider.id, accountEmail: "claude@example.com" },
  ]);
});

test("me-model-providers-upsert-009 imports Codex auth.json with ID-token account, plan, credits and usage", async () => {
  const usage = usageBody();
  const seen = codexProvider({
    usage: () => {
      return HttpResponse.json({
        ...usage.body,
        workspace: { name: "Personal Acme" },
        rate_limit_reset_credits: { available_count: 3 },
      });
    },
  });
  const earliest = new Date(now() + 2 * 3_600_000).toISOString();
  server.use(
    http.get(detailsUrl, () => {
      return HttpResponse.json({
        credits: [
          {
            status: "redeemed",
            expires_at: new Date(now() + 600_000).toISOString(),
          },
          {
            status: "available",
            expires_at: new Date(now() + 9 * 3_600_000).toISOString(),
          },
          { status: "available", expires_at: earliest },
          { status: "available", expires_at: null },
        ],
      });
    }),
  );
  const idTokenAccountId = randomUUID();
  const raw = JSON.stringify({
    tokens: {
      access_token: jwt({ exp: Math.floor(now() / 1000) + 7200 }),
      refresh_token: `refresh-${randomUUID()}`,
      account_id: randomUUID(),
      id_token: jwt({
        email: "codex-owner@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: idTokenAccountId,
          chatgpt_plan_type: "pro",
        },
      }),
    },
  });

  const imported = await importCodex(raw);
  const providers = await imported.list();

  expect(seen.usageAccounts[0]).toBe(idTokenAccountId);
  expect(imported.created.body.provider).toMatchObject({
    type: "codex-oauth-token",
    workspaceName: "Personal Acme",
    planType: "pro",
    subscriptionResetPeriod: "weekly",
    subscriptionNextResetAt: new Date(usage.weeklyReset * 1000).toISOString(),
    needsReconnect: false,
  });
  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    id: imported.created.body.provider.id,
    accountEmail: "codex-owner@example.com",
    subscriptionResetCredits: 3,
    subscriptionResetCreditsNextExpiresAt: earliest,
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 25,
        resetAt: new Date(usage.fiveHourReset * 1000).toISOString(),
        windowSeconds: FIVE_HOURS,
      },
      weekly: {
        usedPercent: 40,
        resetAt: new Date(usage.weeklyReset * 1000).toISOString(),
        windowSeconds: WEEK,
      },
    },
  });
});

test("me-model-providers-upsert-011 consumes a Codex reset credit with the idempotency key", async () => {
  const seen = codexProvider({
    usage: () => {
      return HttpResponse.json({
        plan_type: "pro",
        rate_limit_reset_credits: { available_count: 2 },
      });
    },
  });
  const fixture = await codexFixture();
  const idempotencyKey = randomUUID();

  fixture.session();
  const result = await accept(resetByType(idempotencyKey), [200]);

  expect(result.body).toMatchObject({ outcome: "reset" });
  expect(seen.consumed).toStrictEqual([
    {
      bearer: `Bearer ${fixture.auth.accessToken}`,
      accountId: fixture.auth.accountId,
      body: { redeem_request_id: idempotencyKey },
    },
  ]);
});

test("me-model-providers-upsert-012 refreshes an expired Codex token once before consuming a reset credit", async () => {
  const fresh = freshTokens();
  const seen = codexProvider({ refresh: fresh.response });
  const auth = expiredCredentials();
  const fixture = await codexFixture({ auth });
  const idempotencyKey = randomUUID();

  fixture.session();
  const result = await accept(resetByType(idempotencyKey), [200]);

  expect(result.body).toMatchObject({ outcome: "reset" });
  expect(seen.refreshTokens).toStrictEqual([storedRefreshToken(auth)]);
  expect(seen.consumed).toStrictEqual([
    {
      bearer: `Bearer ${fresh.accessToken}`,
      accountId: auth.accountId,
      body: { redeem_request_id: idempotencyKey },
    },
  ]);
});

test("me-model-providers-upsert-013 marks the account for reconnect without consuming after a terminal refresh failure", async () => {
  const seen = codexProvider({
    refresh: () => {
      return HttpResponse.json(
        {
          error: {
            code: "refresh_token_expired",
            message: "refresh token expired",
          },
        },
        { status: 401 },
      );
    },
  });
  const fixture = await codexFixture({ auth: expiredCredentials() });

  fixture.session();
  const reset = await setupApp({
    context,
    routes: meModelProviderAccountRoutes,
  })(personalModelProviderAccountsByIdContract).resetSubscriptionUsage({
    headers,
    params: { id: fixture.id },
    body: { idempotencyKey: randomUUID() },
  });
  const refreshesAfterReset = seen.refreshTokens.length;
  const providers = await fixture.list();

  expect(reset.status).toBe(500);
  expect(refreshesAfterReset).toBe(1);
  expect(seen.consumed).toHaveLength(0);
  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    id: fixture.id,
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
  });
});

test("me-model-providers-upsert-015 refreshes an expired Codex account once and reuses the rotated token", async () => {
  const fresh = freshTokens();
  const usage = usageBody();
  const seen = codexProvider({
    refresh: fresh.response,
    usage: (call) => {
      return call === 1
        ? HttpResponse.json({ detail: "expired" }, { status: 401 })
        : HttpResponse.json(usage.body);
    },
  });
  const auth = expiredCredentials();

  const imported = await importCodex(auth.raw);
  const first = await imported.list();
  const second = await imported.list();

  const id = imported.created.body.provider.id;
  expect(imported.created.body.provider.needsReconnect).toBeFalsy();
  for (const providers of [first, second]) {
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id,
      needsReconnect: false,
      subscriptionUsage: {
        fiveHour: { usedPercent: 25 },
        weekly: { usedPercent: 40 },
      },
    });
  }
  expect(seen.refreshTokens).toHaveLength(1);
  expect(seen.usageTokens).toStrictEqual([
    `Bearer ${auth.accessToken}`,
    `Bearer ${fresh.accessToken}`,
    `Bearer ${fresh.accessToken}`,
  ]);
  expect(seen.usageAccounts).toStrictEqual([
    auth.accountId,
    auth.accountId,
    auth.accountId,
  ]);
});

test("me-model-providers-upsert-019 keeps the Codex provider through an upstream usage outage", async () => {
  const usage = usageBody();
  const seen = codexProvider({
    usage: (call) => {
      return call <= 2
        ? HttpResponse.json({ detail: "unavailable" }, { status: 503 })
        : HttpResponse.json(usage.body);
    },
  });

  const imported = await importCodex(credentials().raw);
  const during = await imported.list();
  const recovered = await imported.list();

  const id = imported.created.body.provider.id;
  expect(during).toHaveLength(1);
  expect(during[0]).toMatchObject({
    id,
    needsReconnect: false,
    lastRefreshErrorCode: null,
  });
  expect(during[0]?.subscriptionUsage ?? null).toBeNull();
  expect(seen.refreshTokens).toHaveLength(0);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    id,
    subscriptionUsage: {
      fiveHour: { usedPercent: 25 },
      weekly: { usedPercent: 40 },
    },
  });
  expect(seen.usageTokens).toHaveLength(3);
});

test("me-model-providers-upsert-020 rejects Codex auth.json without a refresh token", async () => {
  const client = member();
  const accountId = randomUUID();

  const result = await accept(
    client.upsert({
      headers,
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: codexAuthJson({
            access_token: jwt({ exp: Math.floor(now() / 1000) + 3600 }),
            account_id: accountId,
            id_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: accountId,
                chatgpt_plan_type: "plus",
              },
            }),
          }),
        },
      },
    }),
    [400],
  );

  expect(result.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
});

test("me-model-providers-upsert-021 rejects a free-plan Codex account", async () => {
  const client = member();
  const accountId = randomUUID();

  const result = await accept(
    client.upsert({
      headers,
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: codexAuthJson({
            access_token: jwt({ exp: Math.floor(now() / 1000) + 3600 }),
            refresh_token: `refresh-${randomUUID()}`,
            account_id: accountId,
            id_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: accountId,
                chatgpt_plan_type: "free",
              },
            }),
          }),
        },
      },
    }),
    [400],
  );

  expect(result.body.error.code).toBe("CODEX_FREE_PLAN_REJECTED");
});
