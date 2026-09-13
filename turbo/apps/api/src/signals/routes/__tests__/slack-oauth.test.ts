import { randomBytes } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { slackOauthRoutes } from "../slack-oauth";
import {
  countSlackOrgConnections$,
  deleteSlackConnectOrg$,
  findSlackOrgConnection$,
  findSlackOrgInstallation$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/slack-connect";
import { createFixtureTracker } from "./helpers/route-test";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const API_ORIGIN = "https://api.okou.ai";
const WEB_ORIGIN = "https://www.okou.ai";
const APP_ORIGIN = "https://app.okou.ai";
const OKOU_APP_ORIGIN = "https://app.okou.ai";
const OAUTH_STATE_SIGNING_KEY = randomBytes(32).toString("hex");

interface SignedOAuthStatePayload {
  readonly flow: "install" | "connect";
  readonly issuedAt: number;
  readonly orgId: string | null;
  readonly prompt: string | null;
  readonly publicBrand: "vm0" | "okou";
  readonly redirectUri: string;
  readonly reinstall: boolean;
  readonly userId: string | null;
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

function installStateFor(
  query: Readonly<Record<string, string>> = {},
): Promise<string> {
  const search = new URLSearchParams(query).toString();
  return signedStateFromStart(
    `/api/slack/oauth/install${search ? `?${search}` : ""}`,
  );
}

function connectStateFor(
  query: Readonly<Record<string, string>>,
): Promise<string> {
  return signedStateFromStart(
    `/api/slack/oauth/connect?${new URLSearchParams(query).toString()}`,
  );
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

function slackPostMessageContaining(text: string): boolean {
  return context.mocks.slack.chat.postMessage.mock.calls.some((call) => {
    const [message] = call;
    return hasTextField(message) && message.text.includes(text);
  });
}

function hasTextField(value: unknown): value is { readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  );
}

async function seedMembership(
  orgId: string,
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<void> {
  await store.set(seedOrgMembership$, { orgId, userId, role }, context.signal);
}

describe("Slack OAuth API routes", () => {
  const track = createFixtureTracker<SlackConnectFixture>(async (fixture) => {
    await store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  beforeEach(() => {
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
      expect(scopes).not.toContain("assistant:write");
      expect(scopes).toContain("channels:history");
      expect(scopes).toContain("im:history");
      expect(scopes).toContain("im:read");
      expect(scopes).toContain("commands");
      expect(scopes).toContain("users:read");
      expect(scopes).toContain("files:read");
      expect(scopes).toContain("files:write");
      expect(signedOAuthState(redirectUrl).payload).toMatchObject({
        flow: "install",
        publicBrand: "okou",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("serializes the Okou brand in install state", async () => {
      const response = await appRequest("/api/slack/oauth/install", {
        origin: "https://okou.ai",
      });

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
      );
      expect(signedOAuthState(redirectUrl).payload).toMatchObject({
        publicBrand: "okou",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
      });
    });

    it("includes platform state and truncates prompt by codepoint", async () => {
      const prompt = "\u{1F600}".repeat(600);
      const response = await appRequest(
        `/api/slack/oauth/install?orgId=org_1&userId=user_1&reinstall=1&prompt=${encodeURIComponent(prompt)}`,
      );

      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.orgId).toBe("org_1");
      expect(state.userId).toBe("user_1");
      expect(state.reinstall).toBeTruthy();
      if (!state.prompt) {
        throw new Error("Expected truncated install prompt in state");
      }
      expect([...state.prompt]).toHaveLength(500);
      for (const char of state.prompt) {
        expect(char).toBe("\u{1F600}");
      }
    });

    it("includes the pending prompt in install state when provided", async () => {
      const response = await appRequest(
        `/api/slack/oauth/install?orgId=org_1&userId=user_1&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state).toMatchObject({
        orgId: "org_1",
        prompt: "summarize my inbox",
        publicBrand: "okou",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        userId: "user_1",
      });
    });

    it("truncates long install prompts to protect OAuth state length", async () => {
      const prompt = "x".repeat(1200);

      const response = await appRequest(
        `/api/slack/oauth/install?prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("omits prompt from install state when absent", async () => {
      const response = await appRequest(
        "/api/slack/oauth/install?orgId=org_1&userId=user_1",
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBeNull();
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
      expect(signedOAuthState(redirectUrl).payload.publicBrand).toBe("okou");
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
      expect(signedOAuthState(redirectUrl).payload.publicBrand).toBe("okou");
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
      expect(signedOAuthState(redirectUrl).payload.publicBrand).toBe("okou");
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
      expect(signedOAuthState(redirectUrl).payload.publicBrand).toBe("okou");
    });

    it("returns 503 when Slack client ID is not configured", async () => {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "");

      const response = await appRequest("/api/slack/oauth/install");

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Slack integration is not configured",
      });
    });
  });

  describe("GET /api/slack/oauth/connect", () => {
    it("redirects to Slack OAuth with team and connect state", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
      );
      expect(redirectUrl.searchParams.get("user_scope")).toBe("identity.basic");
      expect(redirectUrl.searchParams.get("team")).toBe(
        fixture.slackWorkspaceId,
      );
      const state = signedOAuthState(redirectUrl).payload;
      expect(state).toMatchObject({
        flow: "connect",
        orgId: fixture.orgId,
        publicBrand: "okou",
        userId: fixture.userId,
      });
    });

    it("uses the API origin for connect callback URLs", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}`,
        {
          origin: API_ORIGIN,
          headers: { "x-okou-web-origin": WEB_ORIGIN },
        },
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
      );
    });

    it("includes the pending prompt in connect state when provided", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state).toMatchObject({
        flow: "connect",
        orgId: fixture.orgId,
        prompt: "summarize my inbox",
        publicBrand: "okou",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        userId: fixture.userId,
      });
    });

    it("truncates long connect prompts to protect OAuth state length", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const prompt = "x".repeat(1200);

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}&prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("truncates connect prompts without splitting Unicode codepoints", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const prompt = "\u{1F600}".repeat(600);

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}&prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      if (!state.prompt) {
        throw new Error("Expected truncated connect prompt in state");
      }
      expect([...state.prompt]).toHaveLength(500);
      for (const char of state.prompt) {
        expect(char).toBe("\u{1F600}");
      }
    });

    it("omits prompt from connect state when absent", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBeNull();
    });

    it("returns 400 when orgId or userId is missing", async () => {
      const response = await appRequest("/api/slack/oauth/connect?orgId=org_1");

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Missing orgId or userId",
      });
    });

    it("returns 404 when no Slack installation exists for the org", async () => {
      const response = await appRequest(
        "/api/slack/oauth/connect?orgId=org_missing&userId=user_1",
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "No Slack workspace installed for this organization",
      });
    });

    it("returns 503 when Slack client ID is not configured", async () => {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "");

      const response = await appRequest(
        "/api/slack/oauth/connect?orgId=org_1&userId=user_1",
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Slack integration is not configured",
      });
    });
  });

  describe("GET /api/integrations/slack/oauth/callback", () => {
    it("stores the official Okou installation and redirects to the app", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: fixture.slackWorkspaceName,
        authedUserId: fixture.slackUserId,
        scope: "chat:write,channels:read",
      });
      const start = await appRequest(
        `/api/slack/oauth/install?orgId=${fixture.orgId}&userId=${fixture.userId}`,
        { origin: API_ORIGIN },
      );
      const state = signedOAuthState(
        new URL(start.headers.get("location")!),
      ).encoded;

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/settings/slack?status=connected`,
      );

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({
        orgId: fixture.orgId,
        installedByUserId: fixture.userId,
        botUserId: "B_TEST",
        botScopes: JSON.stringify(["chat:write", "channels:read"]),
        publicBrand: "okou",
      });
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        }),
      );

      const connection = await store.set(
        findSlackOrgConnection$,
        {
          slackWorkspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
        context.signal,
      );
      expect(connection).toMatchObject({ userId: fixture.userId });
      await flushWaitUntilForTest();
      const slackMessages = JSON.stringify(
        context.mocks.slack.chat.postMessage.mock.calls,
      );
      expect(slackMessages).toContain("connected to Okou");
      expect(slackMessages).toContain("<@B_TEST>");
    });

    it("keeps an Okou flow on Okou while reusing the official installation identity", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const start = await appRequest(
        `/api/slack/oauth/install?orgId=${fixture.orgId}&userId=${fixture.userId}`,
        { origin: API_ORIGIN },
      );
      const state = signedOAuthState(
        new URL(start.headers.get("location")!),
      ).encoded;

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${OKOU_APP_ORIGIN}/settings/slack?status=connected`,
      );
      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({
        botUserId: "B_TEST",
        publicBrand: "okou",
      });
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        }),
      );
      await flushWaitUntilForTest();
      const slackMessages = JSON.stringify(
        context.mocks.slack.chat.postMessage.mock.calls,
      );
      expect(slackMessages).toContain("connected to Okou");
      expect(slackMessages).toContain("<@B_TEST>");
    });

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
        "/slack/failed",
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
        expect(location.pathname).toBe("/slack/failed");
        expect(location.searchParams.get("error")).toBe("Invalid OAuth state.");
        expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
      });
    });

    it.each([
      ["missing", ""],
      ["malformed", `&state=${encodeURIComponent("not-json")}`],
      ["omitted-brand", `&state=${encodeURIComponent("{}")}`],
      [
        "invalid-brand",
        `&state=${encodeURIComponent(JSON.stringify({ publicBrand: "other" }))}`,
      ],
    ])(
      "rejects %s state using the trusted request brand",
      async (_caseName, stateQuery) => {
        const response = await appRequest(
          `/api/integrations/slack/oauth/callback?code=valid-code${stateQuery}`,
          { origin: "https://okou.ai" },
        );

        expect(response.status).toBe(307);
        const location = new URL(response.headers.get("location")!);
        expect(location.origin).toBe(OKOU_APP_ORIGIN);
        expect(location.pathname).toBe("/slack/failed");
        expect(location.searchParams.get("error")).toBe("Invalid OAuth state.");
        expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
      },
    );

    it("uses the configured app for provider errors with malformed state", async () => {
      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?error=access_denied&state=${encodeURIComponent("not-json")}`,
        { origin: "https://okou.ai" },
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe(OKOU_APP_ORIGIN);
      expect(location.pathname).toBe("/slack/failed");
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
      expect(callbackLocation.pathname).toBe("/slack/failed");
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${previewApiOrigin}/api/integrations/slack/oauth/callback`,
        }),
      );
    });

    it("rejects platform install for a non-admin member", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "member");
      mockOAuthSuccess({ teamId: fixture.slackWorkspaceId });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/slack/failed");
      expect(decodeURIComponent(location ?? "")).toContain("Only org admins");
    });

    it("returns a framework error when the platform installer is not an org member", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      mockOAuthSuccess({ teamId: fixture.slackWorkspaceId });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Internal server error",
      });
    });

    it("creates an unbound installation from an unscoped install state", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: fixture.slackWorkspaceName,
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

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation?.orgId).toBeNull();
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
      expect(location).toContain(`${APP_ORIGIN}/slack/failed`);
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
      expect(location).toContain(`${APP_ORIGIN}/slack/failed`);
      expect(decodeURIComponent(location ?? "")).toContain(
        "Failed to complete Slack installation",
      );

      const installation = await store.set(
        findSlackOrgInstallation$,
        "",
        context.signal,
      );
      expect(installation).toBeUndefined();
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
      expect(location).toContain(`${APP_ORIGIN}/slack/failed`);
      if (!location) {
        throw new Error("Expected Slack OAuth failure redirect location");
      }
      expect(decodeURIComponent(location)).toContain(
        "Failed to complete Slack installation",
      );
    });

    it("rejects a platform install when the workspace belongs to another org", async () => {
      const originalOrgId = `org_original_${now()}`;
      const requestingOrgId = `org_requesting_${now()}`;
      const requestingUserId = `user_requesting_${now()}`;
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          {
            orgId: originalOrgId,
            slackWorkspaceId: "T_REJECTED",
          },
          context.signal,
        ),
      );
      await seedMembership(requestingOrgId, requestingUserId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        accessToken: "xoxb-requesting-token",
        authedUserId: "U_REQUESTING",
      });
      const state = await installStateFor({
        orgId: requestingOrgId,
        userId: requestingUserId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "already installed by another organization",
      );

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({ orgId: originalOrgId });
      const connection = await store.set(
        findSlackOrgConnection$,
        {
          slackWorkspaceId: fixture.slackWorkspaceId,
          slackUserId: "U_REQUESTING",
        },
        context.signal,
      );
      expect(connection).toBeUndefined();
    });

    it("updates token and scopes for a same-org platform reinstall", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: "Renamed Workspace",
        accessToken: "xoxb-refreshed-token",
        botUserId: "B_REFRESHED",
        authedUserId: fixture.slackUserId,
        scope: "chat:write,channels:read,users:read",
      });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=reinstall-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/settings/slack?status=connected`,
      );
      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({
        orgId: fixture.orgId,
        slackWorkspaceName: "Renamed Workspace",
        botUserId: "B_REFRESHED",
        botScopes: JSON.stringify([
          "chat:write",
          "channels:read",
          "users:read",
        ]),
        publicBrand: "okou",
      });
    });

    it("creates a single connection across duplicate platform installs", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      await appRequest(
        `/api/integrations/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
      );
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=second-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const count = await store.set(
        countSlackOrgConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(count).toBe(1);
    });

    it("sends the pending prompt DM for platform installs when state includes a prompt", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "summarize my inbox",
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      await flushWaitUntilForTest();
      expect(slackPostMessageContaining("summarize my inbox")).toBeTruthy();
    });

    it("does not send a pending prompt DM for platform installs without a prompt", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      await flushWaitUntilForTest();
      expect(
        slackPostMessageContaining("would you like me to run"),
      ).toBeFalsy();
    });

    it("replays the signed Okou redirect URI in the connect token exchange", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "member");
      const start = await appRequest(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}`,
        { origin: API_ORIGIN },
      );
      const state = signedOAuthState(
        new URL(start.headers.get("location")!),
      ).encoded;
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${OKOU_APP_ORIGIN}/settings/slack?status=connected`,
      );
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        }),
      );
      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation?.publicBrand).toBe("okou");
      await flushWaitUntilForTest();
      expect(
        slackPostMessageContaining("would you like me to run"),
      ).toBeFalsy();
    });

    it("redirects connect flow OAuth exchange failures to the Slack settings error path", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const state = await connectStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
        ok: false,
        error: "invalid_code",
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=expired-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "Failed to connect Slack account",
      );
    });

    it("redirects connect flow when no installation exists for the org", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const state = await connectStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      mockOAuthSuccess({ teamId: "T_MISSING", authedUserId: "U_MISSING" });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "No Slack workspace installed for this organization",
      );
    });

    it("redirects connect flow when Slack returns a different workspace", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      mockOAuthSuccess({
        teamId: "T_DIFFERENT",
        authedUserId: fixture.slackUserId,
      });
      const state = await connectStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "different Slack workspace",
      );
    });

    it("redirects explicit platform reinstalls back to the Works page", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const state = await installStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
        reinstall: "1",
      });

      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?code=reinstall-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/?tab=works&updated=1`,
      );
    });

    it("returns 400 for missing callback code and redirects Slack errors", async () => {
      const missingCode = await appRequest(
        "/api/integrations/slack/oauth/callback",
      );
      expect(missingCode.status).toBe(400);
      await expect(missingCode.json()).resolves.toStrictEqual({
        error: "Missing authorization code",
      });

      const slackError = await appRequest(
        "/api/integrations/slack/oauth/callback?error=access_denied",
      );
      expect(slackError.status).toBe(307);
      expect(slackError.headers.get("location")).toBe(
        `${APP_ORIGIN}/slack/failed?error=access_denied`,
      );
    });
  });
});
