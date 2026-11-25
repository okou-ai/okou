import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { slackOauthRoutes } from "../slack-oauth";

const context = testContext();

const API_ORIGIN = "https://api.okou.ai";
const APP_SETTINGS = "https://app.okou.ai/settings/slack";
const CALLBACK_URI = `${API_ORIGIN}/api/integrations/slack/oauth/callback`;
const INVALID_STATE =
  "Invalid OAuth state. Please reconnect Slack from settings.";

function configureSlackOauth(): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
}

function slackOauth(baseUrl = API_ORIGIN) {
  return setupApp({ context, routes: slackOauthRoutes, baseUrl })(
    slackOauthContract,
  );
}

function locationOf(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location");
  }
  return new URL(location);
}

/** Starts an unscoped bot install and returns Slack's authorization URL. */
async function startInstall(headers?: Record<string, string>) {
  const response = await accept(
    slackOauth().install({
      query: {},
      ...(headers ? { extraHeaders: headers } : {}),
    }),
    [307],
  );
  return { response, authorization: locationOf(response) };
}

function stateOf(authorization: URL): string {
  const state = authorization.searchParams.get("state");
  if (!state) {
    throw new Error("Expected a signed OAuth state");
  }
  return state;
}

function statePayload(state: string): Record<string, unknown> {
  const [encoded] = state.split(".");
  return JSON.parse(
    Buffer.from(encoded ?? "", "base64url").toString(),
  ) as Record<string, unknown>;
}

async function completeCallback(
  query: { code?: string; state?: string; error?: string },
  baseUrl?: string,
) {
  return await accept(slackOauth(baseUrl).callback({ query }), [307]);
}

describe("Slack authorization entry", () => {
  it("slack-oauth-001 sends a named install link to the authenticated settings page", async () => {
    configureSlackOauth();

    const response = await setupRawAppRequest({
      context,
      routes: slackOauthRoutes,
    })(
      `${API_ORIGIN}/api/slack/oauth/install?orgId=org_from_link&userId=user_from_link`,
      { method: "GET" },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(APP_SETTINGS);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("slack-oauth-002 sends a named connect link to the authenticated settings page", async () => {
    configureSlackOauth();

    const response = await setupRawAppRequest({
      context,
      routes: slackOauthRoutes,
    })(
      `${API_ORIGIN}/api/slack/oauth/connect?orgId=org_from_link&userId=user_from_link`,
      { method: "GET" },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(APP_SETTINGS);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/slack/oauth/install", () => {
  it("slack-oauth-005 redirects to Slack with the bot scopes and the API callback", async () => {
    configureSlackOauth();

    const { response, authorization } = await startInstall();

    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(authorization.searchParams.get("client_id")).toBe(
      "test-slack-client-id",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);
    expect(
      (authorization.searchParams.get("scope") ?? "").split(","),
    ).toStrictEqual(
      expect.arrayContaining([
        "app_mentions:read",
        "chat:write",
        "assistant:write",
        "channels:history",
        "im:history",
        "im:read",
        "commands",
        "users:read",
        "files:read",
        "files:write",
        "links:read",
        "links:write",
      ]),
    );
    expect(statePayload(stateOf(authorization))).toMatchObject({
      flow: "install",
      redirectUri: CALLBACK_URI,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("slack-oauth-007 accepts the exact okou.ai web origin for a shared start", async () => {
    configureSlackOauth();

    const { authorization } = await startInstall({
      "x-okou-web-origin": "https://okou.ai",
    });

    expect(authorization.origin).toBe("https://slack.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);
  });

  it("slack-oauth-009 ignores an untrusted web origin header for the callback host", async () => {
    configureSlackOauth();

    const { authorization } = await startInstall({
      "x-okou-web-origin": "https://evil.example",
    });

    expect(authorization.origin).toBe("https://slack.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);
  });
});

describe("GET /api/integrations/slack/oauth/callback", () => {
  it("slack-oauth-011 rejects a tampered signed redirect URI without exchanging the code", async () => {
    configureSlackOauth();
    const { authorization } = await startInstall();
    const [, signature] = stateOf(authorization).split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...statePayload(stateOf(authorization)),
        redirectUri:
          "https://evil.example/api/integrations/slack/oauth/callback",
      }),
    ).toString("base64url");

    const response = await completeCallback({
      code: "slack-code",
      state: `${tamperedPayload}.${signature}`,
    });

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(APP_SETTINGS);
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("slack-oauth-012 rejects a signed state older than fifteen minutes", async () => {
    configureSlackOauth();
    const startedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
    mockNow(startedAt);
    const { authorization } = await startInstall();
    mockNow(startedAt + (15 * 60 + 1) * 1000);

    const response = await completeCallback({
      code: "slack-code",
      state: stateOf(authorization),
    });

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(APP_SETTINGS);
    expect(location.searchParams.get("error")).toBe(INVALID_STATE);
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("slack-oauth-013 rejects a callback without state", async () => {
    configureSlackOauth();

    const response = await completeCallback(
      { code: "slack-code" },
      "https://okou.ai",
    );

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(APP_SETTINGS);
    expect(location.searchParams.get("error")).toBe(INVALID_STATE);
    expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
  });

  it("slack-oauth-017 creates an unbound installation and returns its workspace and user", async () => {
    configureSlackOauth();
    const { authorization } = await startInstall();
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: true,
      access_token: "xoxb-unbound-install",
      bot_user_id: "U_BOT_UNBOUND",
      scope: "app_mentions:read,chat:write",
      team: { id: "T_UNBOUND_NEW", name: "Unbound Workspace" },
      authed_user: { id: "U_UNBOUND_INSTALLER" },
    });

    const response = await completeCallback({
      code: "slack-code",
      state: stateOf(authorization),
    });

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(APP_SETTINGS);
    expect(location.searchParams.get("w")).toBe("T_UNBOUND_NEW");
    expect(location.searchParams.get("u")).toBe("U_UNBOUND_INSTALLER");
  });

  it("slack-oauth-018 sends a failed install exchange to the settings error page", async () => {
    configureSlackOauth();
    const { authorization } = await startInstall();
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: false,
      error: "invalid_code",
    });

    const response = await completeCallback({
      code: "expired-code",
      state: stateOf(authorization),
    });

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(APP_SETTINGS);
    expect(location.searchParams.get("error")).toContain(
      "Failed to complete Slack installation",
    );
  });

  it("slack-oauth-021 forwards a Slack authorization error to settings", async () => {
    configureSlackOauth();

    const response = await completeCallback({ error: "access_denied" });

    expect(response.headers.get("location")).toBe(
      `${APP_SETTINGS}?error=access_denied`,
    );
  });
});
