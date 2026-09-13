import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { mockNow, now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { readUserSecrets } from "./helpers/user-config-state";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "../me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";

const personalModelProvidersMainTestRoutes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);

const personalModelProvidersByTypeTestRoutes = Object.freeze([
  ...meModelProvidersDeleteRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
]);

const personalModelProviderAccountsByIdTestRoutes = Object.freeze([
  ...meModelProviderAccountRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);

interface UserModelProviderFixture {
  readonly orgId: string;
  readonly userId: string;
}

function uniqueOrgUser(prefix: string): UserModelProviderFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

// ===========================================================================
// JWT helpers ported inline from the model-providers route test in the
// removed `apps/web` app. That file no longer exists in the tree, so there
// is nothing left to keep in sync. Used by codex-oauth tests.
// ===========================================================================

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeIdToken(opts: {
  accountId: string;
  planType: string;
  email?: string;
  workspaceName?: string;
}): string {
  const auth: Record<string, unknown> = {
    chatgpt_account_id: opts.accountId,
    chatgpt_plan_type: opts.planType,
  };
  if (opts.workspaceName !== undefined) {
    auth.organization = { title: opts.workspaceName };
  }
  return makeJwt({
    email: opts.email ?? "codex.user@example.com",
    "https://api.openai.com/auth": auth,
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeAuthJsonFixture(
  overrides: {
    readonly accessExpiresInSeconds?: number;
    readonly accountId?: string;
    readonly planType?: string;
    readonly refreshToken?: string;
  } = {},
): {
  readonly accessToken: string;
  readonly accountId: string;
  readonly raw: string;
  readonly refreshToken: string;
} {
  const accountId = overrides.accountId ?? "ws_acct_from_id_token_personal";
  const accessToken = makeJwt({
    exp: Math.floor(now() / 1000) + (overrides.accessExpiresInSeconds ?? 7200),
  });
  const refreshToken =
    overrides.refreshToken ?? "rt_personal_synthetic_high_entropy";
  return {
    accessToken,
    accountId,
    refreshToken,
    raw: JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        account_id: "ws_acct_plain",
        id_token: makeIdToken({
          accountId,
          planType: overrides.planType ?? "plus",
          workspaceName: "Personal Acme",
        }),
      },
    }),
  };
}

function makeAuthJson(overrides?: { readonly planType?: string }): string {
  return makeAuthJsonFixture(overrides).raw;
}

function codexUsageResponse() {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        limit_window_seconds: 18_000,
        reset_at: 1_893_441_600,
        used_percent: 25,
      },
      secondary_window: {
        limit_window_seconds: 604_800,
        reset_at: 1_893_456_000,
        used_percent: 40,
      },
    },
    rate_limit_reset_credits: {
      available_count: 3,
    },
  };
}

async function enablePersonalModelProviderAccounts(
  fixture: UserModelProviderFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
  });
}

describe("POST /api/me/model-providers (upsert)", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("creates a single-secret personal provider", async () => {
    const fixture = uniqueOrgUser("zmmp-single-create");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      provider: {
        type: "claude-code-oauth-token",
        framework: "claude-code",
        isDefault: false,
      },
      created: true,
    });

    const storedSecrets = await readUserSecrets(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(
      storedSecrets.some((secret) => {
        return secret.type === "model-provider";
      }),
    ).toBeTruthy();
    expect(JSON.stringify(storedSecrets)).not.toContain("sk-ant-test");
  });

  it("updates an existing personal provider with 200", async () => {
    const fixture = uniqueOrgUser("zmmp-single-update");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "first" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "second" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({ created: false });
  });

  it("returns 400 when single-secret provider is missing the secret", async () => {
    const fixture = uniqueOrgUser("zmmp-missing-secret");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("returns 404 for anthropic-api-key", async () => {
    const fixture = uniqueOrgUser("zmmp-anthropic-rejected");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "anthropic-api-key" not found',
      },
    });
  });

  it("returns 404 for openai-api-key", async () => {
    const fixture = uniqueOrgUser("zmmp-openai-rejected");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
          selectedModel: "gpt-5.5",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "openai-api-key" not found',
      },
    });
  });

  it("paste valid auth.json persists derived secrets + metadata", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-happy");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        expect(request.headers.get("chatgpt-account-id")).toBe(
          "ws_acct_from_id_token_personal",
        );
        return HttpResponse.json({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 18_000,
              reset_at: 1_893_441_600,
              used_percent: 25,
            },
            secondary_window: {
              limit_window_seconds: 604_800,
              reset_at: 1_893_456_000,
              used_percent: 40,
            },
          },
          rate_limit_reset_credits: {
            available_count: 3,
          },
        });
      }),
      http.get(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        () => {
          return HttpResponse.json({
            available_count: 3,
            credits: [
              {
                id: "credit-later",
                reset_type: "codex_rate_limits",
                status: "available",
                granted_at: "2029-12-01T00:00:00Z",
                expires_at: "2030-02-01T00:00:00Z",
              },
              {
                id: "credit-soonest",
                reset_type: "codex_rate_limits",
                status: "available",
                granted_at: "2029-12-02T00:00:00Z",
                expires_at: "2030-01-15T00:00:00Z",
              },
              {
                id: "credit-never-expires",
                reset_type: "codex_rate_limits",
                status: "available",
                granted_at: "2029-12-03T00:00:00Z",
                expires_at: null,
              },
              {
                id: "credit-redeemed",
                reset_type: "codex_rate_limits",
                status: "redeemed",
                granted_at: "2029-11-01T00:00:00Z",
                expires_at: "2029-12-15T00:00:00Z",
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Personal Acme",
        planType: "pro",
        subscriptionResetPeriod: "weekly",
        subscriptionNextResetAt: "2030-01-01T00:00:00.000Z",
        needsReconnect: false,
      },
    });

    const listed = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders).toHaveLength(1);
    expect(listed.body.modelProviders[0]).toMatchObject({
      type: "codex-oauth-token",
      accountEmail: "codex.user@example.com",
      subscriptionResetCredits: 3,
      subscriptionResetCreditsNextExpiresAt: "2030-01-15T00:00:00.000Z",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 25,
          remainingPercent: 75,
          resetAt: "2029-12-31T20:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 40,
          remainingPercent: 60,
          resetAt: "2030-01-01T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    });
  });

  it("keeps reset credits when the expiry read fails", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-expiry-degraded");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json({
          plan_type: "pro",
          rate_limit_reset_credits: {
            available_count: 2,
          },
        });
      }),
      http.get(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        () => {
          return new HttpResponse(null, { status: 500 });
        },
      ),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    const listed = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders[0]).toMatchObject({
      type: "codex-oauth-token",
      subscriptionResetCredits: 2,
      subscriptionResetCreditsNextExpiresAt: null,
    });
  });

  it("consumes a Codex subscription reset credit", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-reset");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const idempotencyKey = randomUUID();
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json({
          plan_type: "pro",
          rate_limit_reset_credits: {
            available_count: 2,
          },
        });
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        async ({ request }) => {
          expect(request.headers.get("chatgpt-account-id")).toBe(
            "ws_acct_from_id_token_personal",
          );
          await expect(request.json()).resolves.toStrictEqual({
            redeem_request_id: idempotencyKey,
          });
          return HttpResponse.json({
            code: "reset",
            windows_reset: 2,
          });
        },
      ),
    );

    const mainClient = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    await accept(
      mainClient.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    const byTypeClient = setupApp({
      context,
      routes: personalModelProvidersByTypeTestRoutes,
    })(personalModelProvidersByTypeContract);
    const response = await accept(
      byTypeClient.resetSubscriptionUsage({
        params: { type: "codex-oauth-token" },
        body: { idempotencyKey },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ outcome: "reset" });
  });

  it("refreshes an expired Codex token before consuming a reset credit", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-reset-refresh");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const connectedAt = now();
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: 3600 });
    const idempotencyKey = randomUUID();
    const refreshedAccessToken = "fresh-reset-chatgpt-access-token";
    let refreshCalls = 0;
    let consumeCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        refreshCalls += 1;
        await expect(request.json()).resolves.toMatchObject({
          grant_type: "refresh_token",
          refresh_token: authJson.refreshToken,
        });
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          refresh_token: "rotated-reset-chatgpt-refresh-token",
          expires_in: 3600,
        });
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json(codexUsageResponse());
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        async ({ request }) => {
          consumeCalls += 1;
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${refreshedAccessToken}`,
          );
          expect(request.headers.get("chatgpt-account-id")).toBe(
            authJson.accountId,
          );
          await expect(request.json()).resolves.toStrictEqual({
            redeem_request_id: idempotencyKey,
          });
          return HttpResponse.json({ code: "reset", windows_reset: 2 });
        },
      ),
    );

    const mainClient = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    await accept(
      mainClient.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    mockNow(connectedAt + 2 * 3_600_000);

    const byTypeClient = setupApp({
      context,
      routes: personalModelProvidersByTypeTestRoutes,
    })(personalModelProvidersByTypeContract);
    const response = await accept(
      byTypeClient.resetSubscriptionUsage({
        params: { type: "codex-oauth-token" },
        body: { idempotencyKey },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ outcome: "reset" });
    expect(refreshCalls).toBe(1);
    expect(consumeCalls).toBe(1);
  });

  it("does not consume a reset credit after terminal Codex refresh failure", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-reset-terminal");
    await enablePersonalModelProviderAccounts(fixture);
    const connectedAt = now();
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: 3600 });
    let refreshCalls = 0;
    let consumeCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "refresh token expired",
            },
          },
          { status: 401 },
        );
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json(codexUsageResponse());
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        () => {
          consumeCalls += 1;
          return HttpResponse.json({ code: "reset", windows_reset: 2 });
        },
      ),
    );

    const mainClient = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const connected = await accept(
      mainClient.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    mockNow(connectedAt + 2 * 3_600_000);

    const accountClient = setupApp({
      context,
      routes: personalModelProviderAccountsByIdTestRoutes,
    })(personalModelProviderAccountsByIdContract);
    const failed = await accept(
      accountClient.resetSubscriptionUsage({
        params: { id: connected.body.provider.id },
        body: { idempotencyKey: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );
    expect(failed.status).toBe(500);

    const listed = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(listed.body.modelProviders[0]).toMatchObject({
      id: connected.body.provider.id,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
    expect(refreshCalls).toBe(1);
    expect(consumeCalls).toBe(0);
  });

  it("retries reset after transient Codex refresh failure", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-reset-transient");
    await enablePersonalModelProviderAccounts(fixture);
    const connectedAt = now();
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: 3600 });
    const idempotencyKey = randomUUID();
    const refreshedAccessToken = "recovered-reset-chatgpt-access-token";
    let refreshCalls = 0;
    let consumeCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return HttpResponse.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          refresh_token: "recovered-reset-chatgpt-refresh-token",
          expires_in: 3600,
        });
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        return HttpResponse.json(codexUsageResponse());
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        ({ request }) => {
          consumeCalls += 1;
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${refreshedAccessToken}`,
          );
          return HttpResponse.json({ code: "reset", windows_reset: 2 });
        },
      ),
    );

    const mainClient = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const connected = await accept(
      mainClient.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    mockNow(connectedAt + 2 * 3_600_000);

    const accountClient = setupApp({
      context,
      routes: personalModelProviderAccountsByIdTestRoutes,
    })(personalModelProviderAccountsByIdContract);
    const reset = () => {
      return accountClient.resetSubscriptionUsage({
        params: { id: connected.body.provider.id },
        body: { idempotencyKey },
        headers: { authorization: "Bearer clerk-session" },
      });
    };
    const unavailable = await accept(reset(), [500]);
    expect(unavailable.status).toBe(500);

    const recovered = await accept(reset(), [200]);
    expect(recovered.body).toStrictEqual({ outcome: "reset" });
    expect(refreshCalls).toBe(2);
    expect(consumeCalls).toBe(1);
  });

  it("coalesces concurrent refreshes for an expired Codex account", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-refresh");
    await enablePersonalModelProviderAccounts(fixture);
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: -60 });
    const refreshedAccessToken = "fresh-chatgpt-access-token";
    const refreshedRefreshToken = "rotated-chatgpt-refresh-token";
    const usageAuthorizations: (string | null)[] = [];
    let refreshCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        refreshCalls += 1;
        await expect(request.json()).resolves.toMatchObject({
          grant_type: "refresh_token",
          refresh_token: authJson.refreshToken,
        });
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          refresh_token: refreshedRefreshToken,
          expires_in: 3600,
        });
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        const authorization = request.headers.get("authorization");
        usageAuthorizations.push(authorization);
        if (authorization === `Bearer ${authJson.accessToken}`) {
          return HttpResponse.json({ error: "expired" }, { status: 401 });
        }
        expect(authorization).toBe(`Bearer ${refreshedAccessToken}`);
        expect(request.headers.get("chatgpt-account-id")).toBe(
          authJson.accountId,
        );
        return HttpResponse.json(codexUsageResponse());
      }),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const connected = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(connected.body.provider).toMatchObject({
      modelProviderId: expect.any(String),
      needsReconnect: false,
    });
    const [first, second] = await Promise.all([
      accept(
        client.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      ),
      accept(
        client.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      ),
    ]);
    for (const response of [first, second]) {
      expect(response.body.modelProviders[0]).toMatchObject({
        id: connected.body.provider.id,
        needsReconnect: false,
        subscriptionUsage: {
          fiveHour: { usedPercent: 25 },
          weekly: { usedPercent: 40 },
        },
      });
    }
    expect(refreshCalls).toBe(1);
    expect(usageAuthorizations).toStrictEqual([
      `Bearer ${authJson.accessToken}`,
      `Bearer ${refreshedAccessToken}`,
      `Bearer ${refreshedAccessToken}`,
    ]);

    await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(refreshCalls).toBe(1);
  });

  it("returns and short-circuits terminal Codex reconnect state", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-terminal");
    await enablePersonalModelProviderAccounts(fixture);
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: -60 });
    let refreshCalls = 0;
    let usageCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "refresh token expired",
            },
          },
          { status: 401 },
        );
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        usageCalls += 1;
        return HttpResponse.json({ error: "expired" }, { status: 401 });
      }),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const connected = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      const listed = await accept(
        client.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(listed.body.modelProviders[0]).toMatchObject({
        id: connected.body.provider.id,
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      });
    }

    expect(refreshCalls).toBe(1);
    expect(usageCalls).toBe(1);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("retries transient Codex refresh failure without false reconnect", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-transient");
    await enablePersonalModelProviderAccounts(fixture);
    const authJson = makeAuthJsonFixture({ accessExpiresInSeconds: -60 });
    let refreshCalls = 0;
    let usageCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return HttpResponse.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          access_token: "recovered-chatgpt-access-token",
          refresh_token: "recovered-chatgpt-refresh-token",
          expires_in: 3600,
        });
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        usageCalls += 1;
        if (
          request.headers.get("authorization") ===
          `Bearer ${authJson.accessToken}`
        ) {
          return HttpResponse.json({ error: "expired" }, { status: 401 });
        }
        return HttpResponse.json(codexUsageResponse());
      }),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson.raw },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    const unavailable = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(unavailable.body.modelProviders[0]).toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    expect(
      unavailable.body.modelProviders[0]?.subscriptionUsage,
    ).toBeUndefined();

    const recovered = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(recovered.body.modelProviders[0]).toMatchObject({
      needsReconnect: false,
      subscriptionUsage: {
        fiveHour: { usedPercent: 25 },
        weekly: { usedPercent: 40 },
      },
    });
    expect(refreshCalls).toBe(2);
    expect(usageCalls).toBe(2);
  });

  it("isolates Codex usage response failures to account enrichment", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-usage-errors");
    await enablePersonalModelProviderAccounts(fixture);
    let usageCalls = 0;
    let refreshCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        return HttpResponse.error();
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        usageCalls += 1;
        if (usageCalls === 1) {
          return HttpResponse.json(codexUsageResponse());
        }
        if (usageCalls === 2) {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        return HttpResponse.json({ plan_type: 123 });
      }),
    );

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const connected = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    const unauthorized = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(unauthorized.body.modelProviders[0]).toMatchObject({
      id: connected.body.provider.id,
      needsReconnect: false,
    });
    expect(
      unauthorized.body.modelProviders[0]?.subscriptionUsage,
    ).toBeUndefined();

    const unrecognized = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(unrecognized.body.modelProviders[0]).toMatchObject({
      id: connected.body.provider.id,
      needsReconnect: false,
    });
    expect(
      unrecognized.body.modelProviders[0]?.subscriptionUsage,
    ).toBeUndefined();
    expect(refreshCalls).toBe(0);
    expect(usageCalls).toBe(3);
  });

  it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID on malformed JSON", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-malformed");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: "{ not json" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });
  });

  it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID when tokens.refresh_token missing", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-missing-rt");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const incomplete = JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: now() }),
        // refresh_token omitted
        account_id: "ws_acct",
        id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
      },
    });

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: incomplete },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });
  });

  it("returns 400 CODEX_FREE_PLAN_REJECTED for free-plan accounts", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-free");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ planType: "free" }) },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_FREE_PLAN_REJECTED" },
    });
  });

  it("returns 400 BAD_REQUEST when CODEX_AUTH_JSON is missing from secrets", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-no-blob");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: personalModelProvidersMainTestRoutes,
    })(personalModelProvidersMainContract);
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
