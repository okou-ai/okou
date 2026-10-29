import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { slackOauthRoutes } from "../slack-oauth";
import { uniqueSlackUserId } from "./helpers/slack-public-install";

const context = testContext();
const API_ORIGIN = "https://api.okou.ai";
const WEB_ORIGIN = "https://www.okou.ai";
const APP_ORIGIN = "https://app.okou.ai";
const OAUTH_STATE_SIGNING_KEY = randomBytes(32).toString("hex");
interface SignedOAuthStatePayload {
  readonly flow: "install";
  readonly issuedAt: number;
  readonly orgId: null;
  readonly userId: null;
  readonly redirectUri: string;
}

async function appRequest(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: RequestInit["headers"];
  } = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: slackOauthRoutes,
  });
  return await app.request(`${options.origin ?? "http://api.test"}${path}`, {
    method: "GET",
    headers: options.headers,
  });
}

function mockSlackEnv(): void {
  mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
}

function signedOAuthState(authorizationUrl: URL): {
  readonly encoded: string;
  readonly payload: SignedOAuthStatePayload;
} {
  const state = authorizationUrl.searchParams.get("state");
  if (!state) {
    throw new Error("Expected signed Slack OAuth state");
  }
  const [encodedPayload, signature, extra] = state.split(".");
  if (!encodedPayload || !signature || extra) {
    throw new Error("Expected payload and signature in Slack OAuth state");
  }
  return {
    encoded: state,
    payload: JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString(),
    ) as SignedOAuthStatePayload,
  };
}

async function signedStateFromStart(path: string): Promise<string> {
  const start = await appRequest(path, { origin: API_ORIGIN });
  const location = start.headers.get("location");
  if (start.status !== 307 || !location) {
    throw new Error(
      `Expected a Slack OAuth start redirect, received ${start.status}`,
    );
  }
  return signedOAuthState(new URL(location)).encoded;
}

function installStateFor(): Promise<string> {
  return signedStateFromStart("/api/slack/oauth/install");
}

function mockOAuthSuccess(
  overrides: {
    readonly accessToken?: string;
    readonly botUserId?: string;
    readonly teamId?: string;
    readonly teamName?: string;
    readonly authedUserId?: string;
    readonly scope?: string;
  } = {},
): void {
  context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: overrides.accessToken ?? "xoxb-test-token",
    bot_user_id: overrides.botUserId ?? "B_TEST",
    team: {
      id: overrides.teamId ?? "T_TEST",
      name: overrides.teamName ?? "Test Workspace",
    },
    authed_user: { id: overrides.authedUserId ?? "U_TEST" },
    scope: overrides.scope,
  });
}

function unseededIdentity() {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
    slackWorkspaceId: `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    slackUserId: uniqueSlackUserId(),
  };
}

function applyOAuthTestEnv(): void {
  mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
  mockEnv("OKOU_API_BACKEND_URL", undefined);
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv("SECRETS_ENCRYPTION_KEY", OAUTH_STATE_SIGNING_KEY);
  mockSlackEnv();
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "mock.ts",
    channel: "D_TEST",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "mock.ephemeral.ts",
  });
}

beforeEach(applyOAuthTestEnv);

describe("Slack authorization entry", () => {
  it.each(["install", "connect"])(
    "returns the authenticated settings entry for a named %s link",
    async (flow) => {
      const response = await appRequest(
        `/api/slack/oauth/${flow}?orgId=org_from_link&userId=user_from_link`,
      );
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${APP_ORIGIN}/settings/slack`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it.each(["orgId=", "userId="])(
    "returns settings for an incomplete identity link containing %s",
    async (query) => {
      const response = await appRequest(`/api/slack/oauth/install?${query}`);
      expect(response.headers.get("location")).toBe(
        `${APP_ORIGIN}/settings/slack`,
      );
    },
  );
});

describe("GET /api/slack/oauth/install", () => {
  it("redirects to Slack OAuth with bot scopes and callback URI", async () => {
    const response = await appRequest("/api/slack/oauth/install");

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location!);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(redirectUrl.searchParams.get("client_id")).toBe(
      "test-slack-client-id",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
    const scopes = redirectUrl.searchParams.get("scope")?.split(",") ?? [];
    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("assistant:write");
    expect(scopes).toContain("channels:history");
    expect(scopes).toContain("im:history");
    expect(scopes).toContain("im:read");
    expect(scopes).toContain("commands");
    expect(scopes).toContain("users:read");
    expect(scopes).toContain("files:read");
    expect(scopes).toContain("files:write");
    expect(scopes).toContain("links:read");
    expect(scopes).toContain("links:write");
    expect(signedOAuthState(redirectUrl).payload).toMatchObject({
      flow: "install",
      redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the configured API origin with production web baselines", async () => {
    const response = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
      headers: { "x-okou-web-origin": WEB_ORIGIN },
    });

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
  });

  it("accepts the exact okou.ai web origin for a shared Okou start", async () => {
    const response = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
      headers: { "x-okou-web-origin": "https://okou.ai" },
    });

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
  });

  it("trusts okou.ai subdomains for shared Okou starts", async () => {
    const response = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
      headers: { "x-okou-web-origin": "https://console.okou.ai" },
    });

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
  });

  it("does not accept a callback host from untrusted request headers", async () => {
    const response = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
      headers: { "x-okou-web-origin": "https://evil.example" },
    });

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
  });

  it("does not trust lookalike okou.ai web origins", async () => {
    const response = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
      headers: {
        "x-okou-web-origin": "https://okou.ai.evil.example",
      },
    });

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
  });
});

describe("GET /api/integrations/slack/oauth/callback", () => {
  it("rejects a tampered signed redirect URI", async () => {
    const start = await appRequest("/api/slack/oauth/install", {
      origin: API_ORIGIN,
    });
    const { encoded } = signedOAuthState(
      new URL(start.headers.get("location")!),
    );
    const [payload, signature] = encoded.split(".") as [string, string];
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as SignedOAuthStatePayload;
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...decoded,
        redirectUri:
          "https://evil.example/api/integrations/slack/oauth/callback",
      }),
    ).toString("base64url");
    const tamperedState = `${tamperedPayload}.${signature}`;

    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(tamperedState)}`,
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/settings/slack",
    );
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("rejects an expired signed OAuth state", async () => {
    const startedAt = Date.parse("2026-09-02T00:00:00.000Z");

    await withMockNowForTest(startedAt, async () => {
      const start = await appRequest("/api/slack/oauth/install", {
        origin: API_ORIGIN,
      });
      const state = signedOAuthState(
        new URL(start.headers.get("location")!),
      ).encoded;
      mockNow(startedAt + 15 * 60 * 1000 + 1000);

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/settings/slack");
      expect(location.searchParams.get("error")).toBe(
        "Invalid OAuth state. Please reconnect Slack from settings.",
      );
      expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["missing", ""],
    ["malformed", `&state=${encodeURIComponent("not-json")}`],
  ])("rejects %s state", async (_caseName, stateQuery) => {
    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code${stateQuery}`,
      { origin: "https://okou.ai" },
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/settings/slack");
    expect(location.searchParams.get("error")).toBe(
      "Invalid OAuth state. Please reconnect Slack from settings.",
    );
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("uses the configured app for provider errors with malformed state", async () => {
    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?error=access_denied&state=${encodeURIComponent("not-json")}`,
      { origin: "https://okou.ai" },
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/settings/slack");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("keeps preview OAuth start and callback handling on the preview API", async () => {
    const previewApiOrigin = "https://pr-22539-api.vm6.ai";
    const previewAppOrigin = "https://pr-22539-app.omby.ai";
    mockEnv("OKOU_WEB_URL", previewApiOrigin);
    mockEnv("OKOU_API_BACKEND_URL", previewApiOrigin);
    mockEnv("APP_URL", previewAppOrigin);

    const start = await appRequest("/api/slack/oauth/install", {
      origin: previewApiOrigin,
    });
    expect(start.status).toBe(307);
    const authorizationUrl = new URL(start.headers.get("location")!);
    expect(authorizationUrl.origin).toBe("https://slack.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${previewApiOrigin}/api/integrations/slack/oauth/callback`,
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected Slack OAuth start state");
    }

    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: false,
      error: "invalid_code",
    });
    const callback = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      { origin: previewApiOrigin },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location")!);
    expect(callbackLocation.origin).toBe(previewAppOrigin);
    expect(callbackLocation.pathname).toBe("/settings/slack");
    expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect_uri: `${previewApiOrigin}/api/integrations/slack/oauth/callback`,
      }),
    );
  });

  it("creates an unbound installation from an unscoped install state", async () => {
    const fixture = unseededIdentity();
    mockOAuthSuccess({
      teamId: fixture.slackWorkspaceId,
      authedUserId: fixture.slackUserId,
    });

    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(await installStateFor())}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/slack`);
    expect(location).toContain(`w=${fixture.slackWorkspaceId}`);
    expect(location).toContain(`u=${fixture.slackUserId}`);
  });

  it("redirects to the failed page when the install OAuth exchange fails", async () => {
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: false,
      error: "invalid_code",
    });

    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=expired-code&state=${encodeURIComponent(await installStateFor())}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/slack`);
    expect(decodeURIComponent(location ?? "")).toContain(
      "Failed to complete Slack installation",
    );
  });

  it("rejects an install OAuth response without a workspace ID", async () => {
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: true,
      access_token: "xoxb-test-token",
      bot_user_id: "B_TEST",
      team: { name: "Test Workspace" },
      authed_user: { id: "U_TEST" },
    });

    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(await installStateFor())}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/slack`);
    expect(decodeURIComponent(location ?? "")).toContain(
      "Failed to complete Slack installation",
    );
  });

  it("rejects an install OAuth response without an authenticated user ID", async () => {
    const teamId = "T_MISSING_AUTHENTICATED_USER";
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: true,
      access_token: "xoxb-test-token",
      bot_user_id: "B_TEST",
      team: { id: teamId, name: "Test Workspace" },
    });

    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(await installStateFor())}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/slack`);
    if (!location) {
      throw new Error("Expected Slack OAuth failure redirect location");
    }
    expect(decodeURIComponent(location)).toContain(
      "Failed to complete Slack installation",
    );
  });

  it("redirects Slack errors", async () => {
    const slackError = await appRequest(
      "/api/integrations/slack/oauth/callback?error=access_denied",
    );
    expect(slackError.status).toBe(307);
    expect(slackError.headers.get("location")).toBe(
      `${APP_ORIGIN}/settings/slack?error=access_denied`,
    );
  });
});
