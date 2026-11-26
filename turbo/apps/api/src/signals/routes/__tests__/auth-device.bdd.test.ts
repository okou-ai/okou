import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { now } from "../../../lib/time";

const context = testContext();
const api = createAuthDeviceApiActions(context);
const support = createAuthDeviceSupportApi(context);

function newUser(
  overrides: Partial<Pick<ApiTestUser, "orgId" | "orgRole">> = {},
): ApiTestUser {
  const userId = `user_${randomUUID()}`;
  return {
    userId,
    orgId:
      overrides.orgId === undefined ? `org_${randomUUID()}` : overrides.orgId,
    orgRole: overrides.orgRole ?? "org:admin",
    email: `${userId}@example.test`,
  };
}

function stateOf(browserUrl: string): string {
  return new URL(browserUrl).searchParams.get("state") ?? "";
}

async function connectCodex(
  user: ApiTestUser,
  account: {
    readonly accountId: string;
    readonly workspaceName: string;
    readonly accessTokenExpiresAt?: number;
    readonly refreshedAccessTokenExpiresAt?: number;
  },
  mutation: {
    readonly mode: "add" | "reconnect";
    readonly modelProviderId?: string;
  } = { mode: "add" },
) {
  const openai = mockCodexDeviceAuthProvider({
    ...account,
    refreshToken: `rt_${account.accountId}_synthetic_high_entropy`,
  });
  const started = await api.requestCodexStart(
    user,
    "personal",
    [200],
    mutation,
  );
  if (started.status !== 200) {
    throw new Error("Expected a started Codex sign-in");
  }
  const completed = await api.requestCodexComplete(
    user,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected a completed Codex sign-in");
  }
  return { ...completed.body, openai };
}

async function codexAccounts(user: ApiTestUser) {
  const listed = await support.listPersonalModelProviders(user, [200]);
  if (listed.status !== 200) {
    throw new Error("Expected the provider list");
  }
  return listed.body.modelProviders.filter((provider) => {
    return provider.type === "codex-oauth-token";
  });
}

describe("AUTH-02: CLI device authorization", () => {
  it("auth-device.bdd-001 signs the CLI in after the user approves its code", async () => {
    const user = newUser();
    const device = await api.startCliDevice();
    expect(device.device_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(device.user_code).toBe(device.device_code);
    expect(device.verification_path).toBe("/cli-auth");
    expect(device.expires_in).toBe(900);
    expect(device.interval).toBe(5);

    const pending = await api.requestCliToken(device.device_code, [202]);
    expect(pending.body).toMatchObject({ error: "authorization_pending" });

    const approved = await api.requestCliApproval(
      user,
      { device_code: `  ${device.user_code.toLowerCase()}  ` },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const issued = await api.requestCliToken(device.device_code, [200]);
    if (issued.status !== 200) {
      throw new Error("Expected an issued CLI token");
    }
    expect(issued.body.token_type).toBe("Bearer");
    expect(issued.body.access_token).toMatch(/^vm0_pat_/);

    const me = await api.readMeWithBearer(
      issued.body.access_token,
      user,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: user.userId,
      email: user.email,
      orgId: user.orgId,
    });

    const reused = await api.requestCliToken(device.device_code, [400]);
    expect(reused.body).toMatchObject({ error: "invalid_request" });
  });

  it("auth-device.bdd-002 reports bad CLI device requests to the caller", async () => {
    const user = newUser();
    const empty = await api.requestCliToken("", [400]);
    expect(empty.body).toMatchObject({ error: "invalid_request" });
    expect(JSON.stringify(empty.body)).toContain("device_code is required");

    const unknown = await api.requestCliApproval(
      user,
      { device_code: "ABCD-EFGH" },
      [400],
    );
    expect(unknown.body).toMatchObject({
      success: false,
      error: "Invalid or expired device code",
    });

    const anonymous = await api.requestCliApproval(
      null,
      { device_code: "ABCD-EFGH" },
      [401],
    );
    expect(JSON.stringify(anonymous.body)).toContain("UNAUTHORIZED");
  });
});

describe("AUTH-02: platform realtime token", () => {
  it("auth-device.bdd-005 issues a fresh signed request when the client renews its token", async () => {
    const user = newUser();
    const signed = (nonce: string) => {
      return {
        keyName: "app.key",
        ttl: 3_600_000,
        timestamp: 1_900_000_000_000,
        capability: JSON.stringify({ [`user:${user.userId}`]: ["subscribe"] }),
        clientId: user.userId,
        nonce,
        mac: `mac-${nonce}`,
      };
    };
    context.mocks.ably.createTokenRequest
      .mockResolvedValueOnce(signed("nonce-first"))
      .mockResolvedValueOnce(signed("nonce-renewed"));

    const first = await api.requestPlatformRealtimeToken(user, [200]);
    const renewed = await api.requestPlatformRealtimeToken(user, [200]);
    expect(first.body).toStrictEqual(signed("nonce-first"));
    expect(renewed.body).toStrictEqual(signed("nonce-renewed"));
  });
});

describe("MODEL-PROVIDER: device auth boundaries", () => {
  it("auth-device.bdd-007 lets only the owner cancel a pending Codex sign-in", async () => {
    const user = newUser({ orgRole: "org:member" });
    const otherMember = newUser({ orgId: user.orgId, orgRole: "org:member" });
    const userCodeRequests: unknown[] = [];
    const polls: unknown[] = [];
    server.use(
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        async ({ request }) => {
          userCodeRequests.push(await request.json());
          return HttpResponse.json({
            device_auth_id: "device_auth_bdd",
            user_code: "CODEX-BDD",
            interval: "7",
          });
        },
      ),
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/token",
        async ({ request }) => {
          polls.push(await request.json());
          return HttpResponse.json(
            { error: "authorization_pending" },
            { status: 403 },
          );
        },
      ),
    );

    const started = await api.requestCodexStart(user, "personal", [200]);
    if (started.status !== 200) {
      throw new Error("Expected a started Codex sign-in");
    }
    expect(started.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "CODEX-BDD",
      interval: 7,
    });
    expect(started.body.sessionToken).toBeTruthy();
    expect(userCodeRequests).toStrictEqual([
      { client_id: "test-codex-client-id" },
    ]);

    const sessionToken = started.body.sessionToken;
    const first = await api.requestCodexComplete(user, sessionToken, [200]);
    expect(first.body).toStrictEqual({ status: "pending", errorMessage: null });
    expect(polls).toStrictEqual([
      { device_auth_id: "device_auth_bdd", user_code: "CODEX-BDD" },
    ]);

    const foreign = await api.requestCodexCancel(
      otherMember,
      sessionToken,
      [404],
    );
    expect(JSON.stringify(foreign.body)).toContain("NOT_FOUND");

    const cancelled = await api.requestCodexCancel(user, sessionToken, [200]);
    expect(cancelled.body).toStrictEqual({ status: "cancelled" });
    const after = await api.requestCodexComplete(user, sessionToken, [200]);
    expect(after.body).toMatchObject({
      status: "pending",
      errorMessage: "Codex device auth session was cancelled",
    });
  });

  it("auth-device.bdd-012 connects a personal Codex account for an administrator", async () => {
    const user = newUser();
    const openai = mockCodexDeviceAuthProvider();

    const started = await api.requestCodexStart(user, "personal", [200]);
    if (started.status !== 200) {
      throw new Error("Expected a started Codex sign-in");
    }
    expect(started.body).toMatchObject({
      status: "pending",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(openai.userCode).toStrictEqual([
      { client_id: "test-codex-client-id" },
    ]);

    const completed = await api.requestCodexComplete(
      user,
      started.body.sessionToken,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
        planType: "plus",
      },
    });
    expect(openai.deviceToken).toHaveLength(1);
    expect(openai.oauthToken).toHaveLength(1);
    const exchange = openai.oauthToken[0];
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code")).toBe("auth_code_test");
    expect(exchange?.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(exchange?.get("client_id")).toBe("test-codex-client-id");
    expect(exchange?.get("code_verifier")).toBe("code_verifier_test");

    const listed = await support.listPersonalModelProviders(user, [200]);
    if (listed.status !== 200) {
      throw new Error("Expected the provider list");
    }
    expect(
      listed.body.modelProviders.map((provider) => {
        return provider.type;
      }),
    ).toContain("codex-oauth-token");

    const repeated = await api.requestCodexComplete(
      user,
      started.body.sessionToken,
      [200],
    );
    expect(repeated.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(openai.deviceToken).toHaveLength(1);

    await support.deletePersonalModelProvider(user, "codex-oauth-token", [204]);
  });

  it("auth-device.bdd-015 refreshes and resets the requested inactive Codex account", async () => {
    const user = newUser({ orgRole: "org:member" });
    await connectCodex(user, {
      accountId: `acct_active_${randomUUID()}`,
      workspaceName: "Active Account",
    });
    const requestedAccountId = `acct_requested_${randomUUID()}`;
    const nowSeconds = Math.floor(now() / 1000);
    const requested = await connectCodex(user, {
      accountId: requestedAccountId,
      workspaceName: "Requested Account",
      accessTokenExpiresAt: nowSeconds - 60,
      refreshedAccessTokenExpiresAt: nowSeconds + 7200,
    });
    expect(requested.provider.isActive).toBeFalsy();
    const consumed: { headers: Headers; body: unknown }[] = [];
    server.use(
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        async ({ request }) => {
          consumed.push({
            headers: request.headers,
            body: await request.json(),
          });
          return HttpResponse.json({ code: "reset", windows_reset: 1 });
        },
      ),
    );
    const refreshesBefore = requested.openai.oauthToken.length;

    const idempotencyKey = randomUUID();
    const reset = await support.resetPersonalModelProviderAccount(
      user,
      requested.provider.id,
      idempotencyKey,
      [200],
    );
    expect(reset.body).toStrictEqual({ outcome: "reset" });
    const refreshes = requested.openai.oauthToken.slice(refreshesBefore);
    expect(
      refreshes.map((body) => {
        return [body.get("grant_type"), body.get("refresh_token")];
      }),
    ).toStrictEqual([
      ["refresh_token", `rt_${requestedAccountId}_synthetic_high_entropy`],
    ]);
    const refreshed = requested.openai.oauthTokenResponses.at(-1);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.headers.get("authorization")).toBe(
      `Bearer ${refreshed?.access_token}`,
    );
    expect(consumed[0]?.headers.get("chatgpt-account-id")).toBe(
      requestedAccountId,
    );
    expect(consumed[0]?.body).toStrictEqual({
      redeem_request_id: idempotencyKey,
    });
    await support.deletePersonalModelProvider(user, "codex-oauth-token", [204]);
  });

  it("auth-device.bdd-016 keeps a revoked Codex account from affecting another account", async () => {
    const user = newUser({ orgRole: "org:member" });
    const accountA = `acct_a_${randomUUID()}`;
    const accountB = `acct_b_${randomUUID()}`;
    const a = await connectCodex(user, {
      accountId: accountA,
      workspaceName: "Account A",
      accessTokenExpiresAt: Math.floor(now() / 1000) - 60,
    });
    const b = await connectCodex(user, {
      accountId: accountB,
      workspaceName: "Account B",
    });
    const refreshAttempts: string[] = [];
    const usageReads: string[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        refreshAttempts.push(await request.text());
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_invalidated",
              message: "Your refresh token has been invalidated.",
            },
          },
          { status: 401 },
        );
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        usageReads.push(request.headers.get("chatgpt-account-id") ?? "");
        return HttpResponse.json({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18_000,
              reset_after_seconds: 3600,
            },
          },
        });
      }),
    );

    for (let read = 0; read < 2; read += 1) {
      const accounts = await codexAccounts(user);
      expect(
        accounts.find((provider) => {
          return provider.id === a.provider.id;
        }),
      ).toMatchObject({
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_invalidated",
      });
      const listedB = accounts.find((provider) => {
        return provider.id === b.provider.id;
      });
      expect(listedB?.needsReconnect).toBeFalsy();
      expect(listedB?.subscriptionUsage?.fiveHour?.usedPercent).toBe(20);
    }
    expect(refreshAttempts).toHaveLength(1);
    expect(usageReads).toStrictEqual([accountB, accountB]);
    await support.deletePersonalModelProvider(user, "codex-oauth-token", [204]);
  });

  it("auth-device.bdd-017 keeps one Claude Code account per email and workspace", async () => {
    const user = newUser({ orgRole: "org:member" });
    const connect = async (email: string, workspace: string) => {
      mockClaudeCodeTokenEndpoint({
        accountEmail: email,
        organizationName: workspace,
      });
      const started = await api.requestClaudeCodeStart(
        user,
        "personal",
        [200],
        {
          mode: "add",
        },
      );
      if (started.status !== 200) {
        throw new Error("Expected a started Claude Code sign-in");
      }
      const completed = await api.requestClaudeCodeComplete(
        user,
        started.body.sessionToken,
        `auth_code_test#${stateOf(started.body.browserUrl)}`,
        [200],
      );
      if (
        !("status" in completed.body) ||
        completed.body.status !== "complete"
      ) {
        throw new Error("Expected a completed Claude Code sign-in");
      }
      return completed.body;
    };

    const first = await connect("first@example.com", "First Workspace");
    expect(first.provider.isActive).toBeTruthy();
    const second = await connect("second@example.com", "Second Workspace");
    expect(second.provider.isActive).toBeFalsy();

    await support.activatePersonalModelProviderAccount(
      user,
      second.provider.id,
    );
    const afterActivate = await support.listPersonalModelProviders(user, [200]);
    if (afterActivate.status !== 200) {
      throw new Error("Expected the provider list");
    }
    const claudeAccounts = (list: typeof afterActivate.body) => {
      return list.modelProviders.filter((provider) => {
        return provider.type === "claude-code-oauth-token";
      });
    };
    const activated = claudeAccounts(afterActivate.body);
    expect(activated).toHaveLength(2);
    expect(activated[0]).toMatchObject({
      id: second.provider.id,
      isActive: true,
      accountEmail: "second@example.com",
      workspaceName: "Second Workspace",
    });

    const third = await connect("FIRST@example.com", "First Workspace");
    expect(third.provider.id).toBe(first.provider.id);
    expect(third.created).toBeFalsy();
    const finalList = await support.listPersonalModelProviders(user, [200]);
    if (finalList.status !== 200) {
      throw new Error("Expected the provider list");
    }
    const accounts = claudeAccounts(finalList.body);
    expect(accounts).toHaveLength(2);
    expect(
      accounts.find((provider) => {
        return provider.id === first.provider.id;
      }),
    ).toMatchObject({
      accountEmail: "first@example.com",
      workspaceName: "First Workspace",
      isActive: false,
    });

    await support.deletePersonalModelProvider(
      user,
      "claude-code-oauth-token",
      [204],
    );
  });

  it("auth-device.bdd-019 connects Claude Code from a pasted code fragment", async () => {
    const user = newUser();
    const anthropic = mockClaudeCodeTokenEndpoint();

    const started = await api.requestClaudeCodeStart(user, "personal", [200]);
    if (started.status !== 200) {
      throw new Error("Expected a started Claude Code sign-in");
    }
    expect(new URL(started.body.browserUrl).searchParams.get("scope")).toBe(
      "user:profile user:inference",
    );
    const state = stateOf(started.body.browserUrl);

    const completed = await api.requestClaudeCodeComplete(
      user,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "claude-code-oauth-token",
        workspaceName: "Claude User's Organization",
        planType: "pro",
        subscriptionResetPeriod: "weekly",
        subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
      },
    });
    expect(anthropic.token).toHaveLength(1);
    expect(anthropic.token[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "auth_code_test",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "test-claude-code-client-id",
      state,
      expires_in: 31_536_000,
      code_verifier: expect.any(String),
    });
    expect(
      anthropic.profile.map((headers) => {
        return headers.get("anthropic-beta");
      }),
    ).toStrictEqual(["oauth-2025-04-20"]);
    expect(
      anthropic.usage.map((headers) => {
        return headers.get("user-agent");
      }),
    ).toStrictEqual(["claude-code/2.1.161"]);

    const listed = await support.listPersonalModelProviders(user, [200]);
    if (listed.status !== 200) {
      throw new Error("Expected the provider list");
    }
    expect(
      listed.body.modelProviders.map((provider) => {
        return provider.type;
      }),
    ).toContain("claude-code-oauth-token");

    const repeated = await api.requestClaudeCodeComplete(
      user,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [400],
    );
    expect(JSON.stringify(repeated.body)).toContain(
      "Claude Code device auth session is not ready",
    );
    await support.deletePersonalModelProvider(
      user,
      "claude-code-oauth-token",
      [204],
    );
  });

  it("auth-device.bdd-020 shows Claude Code usage after a full callback URL is pasted", async () => {
    const user = newUser({ orgRole: "org:member" });
    mockClaudeCodeTokenEndpoint();

    const started = await api.requestClaudeCodeStart(user, "personal", [200]);
    if (started.status !== 200) {
      throw new Error("Expected a started Claude Code sign-in");
    }
    const callback = new URL("https://platform.claude.com/oauth/code/callback");
    callback.searchParams.set("code", "member_code");
    callback.searchParams.set("state", stateOf(started.body.browserUrl));
    const completed = await api.requestClaudeCodeComplete(
      user,
      started.body.sessionToken,
      callback.toString(),
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      provider: {
        type: "claude-code-oauth-token",
        workspaceName: "Claude User's Organization",
        planType: "pro",
      },
    });

    const listed = await support.listPersonalModelProviders(user, [200]);
    if (listed.status !== 200) {
      throw new Error("Expected the provider list");
    }
    const provider = listed.body.modelProviders.find((candidate) => {
      return candidate.type === "claude-code-oauth-token";
    });
    expect(provider?.subscriptionUsage).toStrictEqual({
      fiveHour: {
        usedPercent: 12,
        remainingPercent: 88,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 24,
        remainingPercent: 76,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    });
    await support.deletePersonalModelProvider(
      user,
      "claude-code-oauth-token",
      [204],
    );
  });
});
