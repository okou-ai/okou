import {
  authenticateCallbackActor,
  callbackAuthenticationModes,
  callbackBrowserHeaders,
  callbackNeedsSignIn,
} from "./helpers/oauth-callback-auth";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { setupApp } from "../../../__tests__/test-helpers";
import { readGetStartedStatus } from "./helpers/get-started";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { slackOauthRoutes } from "../slack-oauth";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicSlackOrgApi,
  type PublicSlackOrgFixture,
  type PublicSlackOrgOptions,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackConnectRoutes } from "../slack-connect";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkUsers } from "./helpers/clerk-users";

const context = testContext();
const store = createStore();
const slackOrgs = createPublicSlackOrgApi(context);
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
  // Model App submitting the provider result with its explicitly arranged session.
  const headers = new Headers(options.headers);
  if (
    path.startsWith("/api/integrations/slack/oauth/callback") &&
    !headers.has("authorization")
  ) {
    headers.set("authorization", "Bearer clerk-session");
  }
  return await app.request(`${options.origin ?? "http://api.test"}${path}`, {
    method: "GET",
    headers,
  });
}

/** Start a legitimate authorization as its explicitly named test caller. */
async function oauthStart(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: RequestInit["headers"];
  } = {},
) {
  const query = new URL(path, API_ORIGIN).searchParams;
  const orgId = query.get("orgId");
  const userId = query.get("userId");
  if (orgId && userId) {
    createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
    return await appRequest(path, {
      ...options,
      headers: { authorization: "Bearer clerk-session", ...options.headers },
    });
  }
  return await appRequest(path, options);
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
  const start = await oauthStart(path, { origin: API_ORIGIN });
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

  beforeEach(() => {
    applyOAuthTestEnv();
  });

  it.each(["install", "connect"])(
    "requires authentication before signing a named identity for %s",
    async (flow) => {
      const response = await appRequest(
        `/api/slack/oauth/${flow}?orgId=org_victim&userId=user_victim`,
      );
      const target = new URL(response.headers.get("location")!);
      expect(target.pathname).toBe("/settings/slack");
      expect(target.searchParams.get("error")).toContain("sign in");
    },
  );

  it.each(["install", "connect"])(
    "rejects an authenticated caller naming another user for %s",
    async (flow) => {
      const victim = unseededIdentity();
      createRouteMocks(context).clerk.session(
        `attacker_${victim.userId}`,
        victim.orgId,
        "org:admin",
      );
      const response = await appRequest(
        `/api/slack/oauth/${flow}?${new URLSearchParams({ orgId: victim.orgId, userId: victim.userId })}`,
        { headers: { authorization: "Bearer clerk-session" } },
      );
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toContain("different account or organization");
    },
  );

  it("checks the authenticated administrator role before starting an installation", async () => {
    const actor = unseededIdentity();
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:member",
    );
    const response = await appRequest(
      `/api/slack/oauth/install?${new URLSearchParams({ orgId: actor.orgId, userId: actor.userId })}`,
      { headers: { authorization: "Bearer clerk-session" } },
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toContain("Only org admins");
  });

  it("rejects a callback after the authenticated Okou actor switches", async () => {
    const fixture = unseededIdentity();
    await seedMembership(fixture.orgId, fixture.userId);
    const state = await installStateFor({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    createRouteMocks(context).clerk.session(
      `other_${fixture.userId}`,
      fixture.orgId,
      "org:admin",
    );
    const response = await appRequest(
      `/api/integrations/slack/oauth/callback?${new URLSearchParams({ state, code: "switched-actor" })}`,
      { headers: { authorization: "Bearer clerk-session" } },
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toContain("active account or organization changed");
    await expect(
      readIntegrationStatus(fixture.orgId, fixture.userId),
    ).resolves.toMatchObject({ isInstalled: false, isConnected: false });
  });

  /**
   * Installs the workspace for an org through the production OAuth install
   * flow, then restores this file's OAuth environment and drains the
   * install's background notifications before the scenario starts.
   */
  async function installPublicOrg(options: PublicSlackOrgOptions = {}) {
    const fixture = await slackOrgs.installOrg(options);
    onTestFinished(() => {
      return slackOrgs.uninstallWorkspace(fixture.slackWorkspaceId);
    });
    await flushWaitUntilForTest();
    applyOAuthTestEnv();
    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.oauth.v2.access.mockClear();
    return fixture;
  }

  /** The admin's public Slack integration status for the org. */
  async function readIntegrationStatus(orgId: string, userId: string) {
    createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
    return (
      await accept(
        setupApp({ context, routes: integrationsSlackRoutes })(
          integrationsSlackContract,
        ).getStatus({ headers: { authorization: "Bearer clerk-session" } }),
        [200],
      )
    ).body;
  }

  /** A fresh org/user/workspace identity with nothing installed. */
  function unseededIdentity() {
    return {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      slackWorkspaceId: `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      slackUserId: uniqueSlackUserId(),
    };
  }

  function ownCallbackInstallations() {
    const installations: PublicSlackOrgFixture[] = [];
    const owner = createFixtureOperationOwner(async () => {
      for (const installation of installations) {
        await slackOrgs.uninstallWorkspace(installation.slackWorkspaceId);
      }
    });
    return {
      run: owner.run,
      install: () => {
        return owner.run(async () => {
          const installation = await slackOrgs.installOrg();
          installations.push(installation);
          await flushWaitUntilForTest();
          applyOAuthTestEnv();
          context.mocks.slack.oauth.v2.access.mockClear();
          return installation;
        });
      },
    };
  }

  function mockCallbackDirectory(actor: ApiTestUser) {
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        primaryEmailAddressId: emailId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        firstName: "Callback",
        lastName: "Member",
      },
    ]);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: actor.orgId
        ? [{ organization: { id: actor.orgId }, role: actor.orgRole }]
        : [],
    });
  }

  function callbackClient() {
    return setupApp({
      context,
      routes: slackOauthRoutes,
      baseUrl: API_ORIGIN,
    })(slackOauthContract);
  }

  async function startPublicCallback(installation: PublicSlackOrgFixture) {
    createRouteMocks(context).clerk.session(
      installation.userId,
      installation.orgId,
      "org:admin",
    );
    const response = await accept(
      callbackClient().connect({
        extraHeaders: { authorization: "Bearer clerk-session" },
        query: { orgId: installation.orgId, userId: installation.userId },
      }),
      [307],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Expected the public Slack authorization URL");
    }
    const url = new URL(location);
    expect(url.searchParams.get("team")).toBe(installation.slackWorkspaceId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    );
    const state = signedOAuthState(url);
    expect(state.payload).toMatchObject({
      flow: "connect",
      orgId: installation.orgId,
      userId: installation.userId,
      redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
    });
    return state.encoded;
  }

  async function readCallbackLink(
    installation: PublicSlackOrgFixture,
    slackUserId: string,
  ) {
    createRouteMocks(context).clerk.session(
      installation.userId,
      installation.orgId,
      "org:admin",
    );
    return await accept(
      setupApp({ context, routes: slackConnectRoutes })(
        slackConnectContract,
      ).getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: { workspaceId: installation.slackWorkspaceId, slackUserId },
      }),
      [200],
    );
  }

  describe("public connect callback membership", () => {
    it("connects distinct public members in A/B/A request order", async () => {
      const owned = ownCallbackInstallations();
      const first = await owned.install();
      const second = await owned.install();

      for (const installation of [first, second, first]) {
        await owned.run(async () => {
          mockCallbackDirectory(installation.actor);
          const state = await startPublicCallback(installation);
          const code = `connect-${randomUUID()}`;
          mockOAuthSuccess({
            teamId: installation.slackWorkspaceId,
            authedUserId: installation.slackUserId,
          });
          const response = await accept(
            callbackClient().callback({
              query: { code, state },
              extraHeaders: { authorization: "Bearer clerk-session" },
            }),
            [307],
          );
          const location = response.headers.get("location");
          expect(location).toBe(
            `${APP_ORIGIN}/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName)}&w=${encodeURIComponent(installation.slackWorkspaceId)}&u=${encodeURIComponent(installation.slackUserId)}`,
          );
          expect(context.mocks.slack.oauth.v2.access).toHaveBeenLastCalledWith({
            client_id: "test-slack-client-id",
            client_secret: "test-slack-client-secret",
            code,
            redirect_uri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
          });
          const status = await readCallbackLink(
            installation,
            installation.slackUserId,
          );
          expect(status.body).toMatchObject({
            isConnected: true,
            workspaceName: installation.slackWorkspaceName,
            linkStatus: { kind: "connected" },
          });
          await flushWaitUntilForTest();
        });
      }
    });

    it("keeps entry-accepted state valid when expiry passes during exchange", async () => {
      const owned = ownCallbackInstallations();
      const installation = await owned.install();
      const startedAt = Date.parse("2026-10-13T13:00:00.000Z");

      await owned.run(async () => {
        await withMockNowForTest(startedAt, async () => {
          mockCallbackDirectory(installation.actor);
          const state = await startPublicCallback(installation);
          context.mocks.slack.oauth.v2.access.mockImplementationOnce(() => {
            mockNow(startedAt + 15 * 60 * 1000 + 1000);
            return Promise.resolve({
              ok: true,
              team: { id: installation.slackWorkspaceId },
              authed_user: { id: installation.slackUserId },
            });
          });
          const response = await accept(
            callbackClient().callback({
              extraHeaders: { authorization: "Bearer clerk-session" },
              query: { code: `connect-${randomUUID()}`, state },
            }),
            [307],
          );
          expect(response.headers.get("location")).toBe(
            `${APP_ORIGIN}/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName)}&w=${encodeURIComponent(installation.slackWorkspaceId)}&u=${encodeURIComponent(installation.slackUserId)}`,
          );
          const status = await readCallbackLink(
            installation,
            installation.slackUserId,
          );
          expect(status.body).toMatchObject({
            isConnected: true,
            linkStatus: { kind: "connected" },
          });
          await flushWaitUntilForTest();
          const exchangeCalls =
            context.mocks.slack.oauth.v2.access.mock.calls.length;
          const expired = await accept(
            callbackClient().callback({
              extraHeaders: { authorization: "Bearer clerk-session" },
              query: { code: `connect-${randomUUID()}`, state },
            }),
            [307],
          );
          const expiredLocation = expired.headers.get("location");
          if (!expiredLocation) {
            throw new Error("Expected the expired OAuth redirect");
          }
          expect(new URL(expiredLocation).pathname).toBe("/settings/slack");
          expect(new URL(expiredLocation).searchParams.get("error")).toBe(
            "Invalid OAuth state.",
          );
          expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledTimes(
            exchangeCalls,
          );
        });
      });
    });

    it("rejects a foreign member and leaves the Slack identity available", async () => {
      const owned = ownCallbackInstallations();
      const installation = await owned.install();
      const foreignActor = createBddApi(context).user();
      const slackUserId = uniqueSlackUserId();

      await owned.run(async () => {
        mockCallbackDirectory(installation.actor);
        const before = await readCallbackLink(installation, slackUserId);
        expect(before.body).toStrictEqual({
          isConnected: false,
          isAdmin: true,
          linkStatus: { kind: "connect" },
        });
        mockCallbackDirectory(foreignActor);
        createRouteMocks(context).clerk.session(
          foreignActor.userId,
          foreignActor.orgId,
          "org:admin",
        );
        const started = await accept(
          callbackClient().connect({
            extraHeaders: { authorization: "Bearer clerk-session" },
            query: { orgId: installation.orgId, userId: foreignActor.userId },
          }),
          [307],
        );
        expect(
          new URL(started.headers.get("location")!).searchParams.get("error"),
        ).toContain("different account or organization");
        mockCallbackDirectory(installation.actor);
        const after = await readCallbackLink(installation, slackUserId);
        expect(after.body).toStrictEqual(before.body);
      });
    });
  });

  describe("GET /api/slack/oauth/install", () => {
    it("redirects to Slack OAuth with bot scopes and callback URI", async () => {
      const response = await oauthStart("/api/slack/oauth/install");

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

    it("includes platform state and truncates prompt by codepoint", async () => {
      const prompt = "\u{1F600}".repeat(600);
      const response = await oauthStart(
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
      const response = await oauthStart(
        `/api/slack/oauth/install?orgId=org_1&userId=user_1&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state).toMatchObject({
        orgId: "org_1",
        prompt: "summarize my inbox",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        userId: "user_1",
      });
    });

    it("truncates long install prompts to protect OAuth state length", async () => {
      const prompt = "x".repeat(1200);

      const response = await oauthStart(
        `/api/slack/oauth/install?prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("omits prompt from install state when absent", async () => {
      const response = await oauthStart(
        "/api/slack/oauth/install?orgId=org_1&userId=user_1",
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBeNull();
    });

    it("uses the configured API origin with production web baselines", async () => {
      const response = await oauthStart("/api/slack/oauth/install", {
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
      const response = await oauthStart("/api/slack/oauth/install", {
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
      const response = await oauthStart("/api/slack/oauth/install", {
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
      const response = await oauthStart("/api/slack/oauth/install", {
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
      const response = await oauthStart("/api/slack/oauth/install", {
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

  describe("GET /api/slack/oauth/connect", () => {
    it("isolates installation and signed identity across successive requests", async () => {
      const installations: PublicSlackOrgFixture[] = [];
      const owner = createFixtureOperationOwner(async () => {
        for (const installation of installations) {
          await slackOrgs.uninstallWorkspace(installation.slackWorkspaceId);
        }
      });
      async function install() {
        return await owner.run(async () => {
          const fixture = await slackOrgs.installOrg({ withConnection: true });
          installations.push(fixture);
          await flushWaitUntilForTest();
          applyOAuthTestEnv();
          return fixture;
        });
      }
      const first = await install();
      const second = await install();
      const missing = unseededIdentity();
      const client = setupApp({
        context,
        routes: slackOauthRoutes,
        baseUrl: "https://incoming.example",
      })(slackOauthContract);

      await withMockNowForTest(1_700_000_000_000, async () => {
        for (const { identity, installed } of [
          { identity: first, installed: true },
          { identity: second, installed: true },
          { identity: missing, installed: false },
          { identity: first, installed: true },
        ]) {
          createRouteMocks(context).clerk.session(
            identity.userId,
            identity.orgId,
            "org:admin",
          );
          const response = await owner.run(() => {
            return accept(
              client.connect({
                extraHeaders: { authorization: "Bearer clerk-session" },
                query: {
                  orgId: identity.orgId,
                  userId: identity.userId,
                  prompt: "connect this workspace",
                },
              }),
              [307, 404],
            );
          });
          if (!installed) {
            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual({
              error: "No Slack workspace installed for this organization",
            });
            continue;
          }
          expect(response.status).toBe(307);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const location = response.headers.get("location");
          if (!location) {
            throw new Error("Expected the Slack authorization redirect");
          }
          const authorization = new URL(location);
          expect(authorization.origin + authorization.pathname).toBe(
            "https://slack.com/oauth/v2/authorize",
          );
          const state = authorization.searchParams.get("state");
          if (!state) {
            throw new Error("Expected the signed connect state");
          }
          expect(Object.fromEntries(authorization.searchParams)).toStrictEqual({
            client_id: "test-slack-client-id",
            user_scope: "identity.basic",
            redirect_uri:
              "https://api.okou.ai/api/integrations/slack/oauth/callback",
            team: identity.slackWorkspaceId,
            state,
          });
          const [payload, signature, extra] = state.split(".");
          if (!payload || !signature || extra) {
            throw new Error("Expected exactly one state payload and signature");
          }
          expect(
            JSON.parse(Buffer.from(payload, "base64url").toString()),
          ).toStrictEqual({
            orgId: identity.orgId,
            userId: identity.userId,
            flow: "connect",
            reinstall: false,
            prompt: "connect this workspace",
            issuedAt: 1_700_000_000,
            nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
            redirectUri:
              "https://api.okou.ai/api/integrations/slack/oauth/callback",
          });
          expect(signature).toBe(
            createHmac("sha256", OAUTH_STATE_SIGNING_KEY)
              .update(`slack-oauth-state-v2:${payload}`)
              .digest("base64url"),
          );
        }
      });
    });

    it("redirects to Slack OAuth with team and connect state", async () => {
      const fixture = await installPublicOrg();

      const response = await oauthStart(
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
        userId: fixture.userId,
      });
    });

    it("uses the API origin for connect callback URLs", async () => {
      const fixture = await installPublicOrg();

      const response = await oauthStart(
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
      const fixture = await installPublicOrg();

      const response = await oauthStart(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state).toMatchObject({
        flow: "connect",
        orgId: fixture.orgId,
        prompt: "summarize my inbox",
        redirectUri: `${API_ORIGIN}/api/integrations/slack/oauth/callback`,
        userId: fixture.userId,
      });
    });

    it("truncates long connect prompts to protect OAuth state length", async () => {
      const fixture = await installPublicOrg();
      const prompt = "x".repeat(1200);

      const response = await oauthStart(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}&prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("truncates connect prompts without splitting Unicode codepoints", async () => {
      const fixture = await installPublicOrg();
      const prompt = "\u{1F600}".repeat(600);

      const response = await oauthStart(
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
      const fixture = await installPublicOrg();

      const response = await oauthStart(
        `/api/slack/oauth/connect?orgId=${fixture.orgId}&userId=${fixture.userId}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = signedOAuthState(redirectUrl).payload;
      expect(state.prompt).toBeNull();
    });

    it("returns 503 when Slack client ID is not configured", async () => {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "");

      const response = await oauthStart(
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
      const fixture = unseededIdentity();
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: "Test Workspace",
        authedUserId: fixture.slackUserId,
        scope: "chat:write,channels:read",
      });
      const start = await oauthStart(
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

      // The org now has the installation, with the narrower granted scopes.
      await expect(
        readIntegrationStatus(fixture.orgId, fixture.userId),
      ).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
        workspaceName: "Test Workspace",
        scopeMismatch: true,
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

    it("keeps an Okou flow on Okou while reusing the official installation identity", async () => {
      const fixture = unseededIdentity();
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const start = await oauthStart(
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
      await expect(
        readIntegrationStatus(fixture.orgId, fixture.userId),
      ).resolves.toMatchObject({ isInstalled: true, isConnected: true });
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
      const start = await oauthStart("/api/slack/oauth/install", {
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
        const start = await oauthStart("/api/slack/oauth/install", {
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
        expect(location.searchParams.get("error")).toBe("Invalid OAuth state.");
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
      expect(location.origin).toBe(OKOU_APP_ORIGIN);
      expect(location.pathname).toBe("/settings/slack");
      expect(location.searchParams.get("error")).toBe("Invalid OAuth state.");
      expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
    });

    it("uses the configured app for provider errors with malformed state", async () => {
      const response = await appRequest(
        `/api/integrations/slack/oauth/callback?error=access_denied&state=${encodeURIComponent("not-json")}`,
        { origin: "https://okou.ai" },
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe(OKOU_APP_ORIGIN);
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

      const start = await oauthStart("/api/slack/oauth/install", {
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

    it("rejects platform install for a non-admin member", async () => {
      const fixture = unseededIdentity();
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
      expect(location).toContain("/settings/slack");
      expect(decodeURIComponent(location ?? "")).toContain("Only org admins");
      expect(
        (await readGetStartedStatus(context, fixture)).recentGrants,
      ).toStrictEqual([]);
    });

    it("returns a framework error when the platform installer is not an org member", async () => {
      const fixture = unseededIdentity();
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

      // The installed workspace is not bound to any org: a member cannot
      // connect to it, only an admin may claim it.
      createRouteMocks(context).clerk.session(
        fixture.userId,
        fixture.orgId,
        "org:member",
      );
      const memberConnect = await accept(
        setupApp({ context, routes: slackConnectRoutes })(
          slackConnectContract,
        ).connect({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            requestUserScopes: true,
            workspaceId: fixture.slackWorkspaceId,
            slackUserId: fixture.slackUserId,
          },
        }),
        [403],
      );
      expect(memberConnect.body.error.message).toContain("Only admins");
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

    it("rejects a platform install when the workspace belongs to another org", async () => {
      const original = await installPublicOrg({ withConnection: true });
      const requesting = unseededIdentity();
      await seedMembership(requesting.orgId, requesting.userId, "admin");
      mockOAuthSuccess({
        teamId: original.slackWorkspaceId,
        accessToken: "xoxb-requesting-token",
        authedUserId: "U_REQUESTING",
      });
      const state = await installStateFor({
        orgId: requesting.orgId,
        userId: requesting.userId,
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

      // The original org keeps its installation and connection; the
      // requesting org neither gained the workspace nor a connection.
      await expect(
        readIntegrationStatus(original.orgId, original.userId),
      ).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
        workspaceName: original.slackWorkspaceName,
      });
      await expect(
        readIntegrationStatus(requesting.orgId, requesting.userId),
      ).resolves.toMatchObject({ isInstalled: false, isConnected: false });
    });

    it("updates token and scopes for a same-org platform reinstall", async () => {
      const fixture = await installPublicOrg({ withConnection: true });
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
      await expect(
        readIntegrationStatus(fixture.orgId, fixture.userId),
      ).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
        workspaceName: "Renamed Workspace",
        scopeMismatch: true,
      });
      await flushWaitUntilForTest();
      expect(
        context.mocks.slack.createClient.mock.calls.map(([token]) => {
          return token;
        }),
      ).toContain("xoxb-refreshed-token");
      expect(
        JSON.stringify(context.mocks.slack.chat.postMessage.mock.calls),
      ).toContain("<@B_REFRESHED>");
    });

    it("keeps duplicate platform installs connected and rewards them once", async () => {
      const fixture = unseededIdentity();
      onTestFinished(() => {
        return slackOrgs.uninstallWorkspace(fixture.slackWorkspaceId);
      });
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
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toContain("expired or was already used");
      await expect(
        readIntegrationStatus(fixture.orgId, fixture.userId),
      ).resolves.toMatchObject({ isInstalled: true, isConnected: true });
      const rewards = await readGetStartedStatus(context, fixture);
      expect(
        rewards.quests.find((q) => {
          return q.key === "slack";
        }),
      ).toMatchObject({
        claimedCount: 1,
        earnedCredits: 2000,
        rewardTarget: "org",
      });
      expect(rewards.recentGrants).toHaveLength(1);
      const grant = rewards.recentGrants[0];
      expect(grant?.rewardTarget).toBe("org");
      if (!grant?.expiresAt || !grant.grantedAt) {
        throw new Error("Missing Slack reward expiry");
      }
      expect(Date.parse(grant.expiresAt) - Date.parse(grant.grantedAt)).toBe(
        168 * 60 * 60 * 1000,
      );

      const headers = { authorization: "Bearer clerk-session" };
      const billing = () => {
        return accept(
          setupApp({ context, routes: billingStatusRoutes })(
            billingStatusContract,
          ).get({ headers }),
          [200],
        );
      };
      expect((await billing()).body.creditGrants).toContainEqual(
        expect.objectContaining({
          source: "get_started_reward",
          remaining: 2000,
          expiresAt: grant.expiresAt,
        }),
      );
      const personal = await accept(
        setupApp({ context, routes: billingUsagePackCreditsRoutes })(
          billingUsagePackCreditsContract,
        ).get({ headers }),
        [200],
      );
      expect(personal.body.bonusCredits).toBe(0);
      mockNow(Date.parse(grant.expiresAt));
      expect((await billing()).body.creditGrants).not.toContainEqual(
        expect.objectContaining({ source: "get_started_reward" }),
      );
      expect(
        (await readGetStartedStatus(context, fixture)).quests.find((q) => {
          return q.key === "slack";
        })?.claimedCount,
      ).toBe(1);
    });

    it("sends the pending prompt DM for platform installs when state includes a prompt", async () => {
      const fixture = unseededIdentity();
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
      const fixture = unseededIdentity();
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
      const fixture = await installPublicOrg();
      await seedMembership(fixture.orgId, fixture.userId, "member");
      const start = await oauthStart(
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
      await flushWaitUntilForTest();
      expect(
        slackPostMessageContaining("would you like me to run"),
      ).toBeFalsy();
    });

    it("redirects connect flow OAuth exchange failures to the Slack settings error path", async () => {
      const fixture = await installPublicOrg();
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
      const fixture = await installPublicOrg();
      const state = await connectStateFor({
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      // An org admin uninstalls the workspace before Slack calls back.
      createRouteMocks(context).clerk.session(
        fixture.actor.userId,
        fixture.orgId,
        "org:admin",
      );
      await accept(
        setupApp({ context, routes: integrationsSlackRoutes })(
          integrationsSlackContract,
        ).disconnect({
          headers: { authorization: "Bearer clerk-session" },
          query: { action: "uninstall" },
        }),
        [200],
      );
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
      const fixture = await installPublicOrg();
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

    it("redirects explicit platform reinstalls to the canonical Slack page", async () => {
      const fixture = await installPublicOrg();
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
        `${APP_ORIGIN}/settings/slack?status=connected&updated=1`,
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
  it.each(callbackAuthenticationModes)(
    "requires the completing actor for legacy Slack install (%s)",
    async (mode) => {
      const actor = createBddApi(context).user();
      authenticateCallbackActor(context, actor);
      const state = await installStateFor({
        orgId: actor.orgId!,
        userId: actor.userId,
      });
      const victimWorkspace = `T_${randomUUID()}`;
      const victimUser = uniqueSlackUserId();
      mockOAuthSuccess({ teamId: victimWorkspace, authedUserId: victimUser });
      const query = { state, code: "provider-result" };
      const browserHeaders = callbackBrowserHeaders(context, mode, actor);
      const browser = await accept(
        callbackClient().callback({
          query,
          extraHeaders: browserHeaders.cookie
            ? { cookie: browserHeaders.cookie }
            : {},
        }),
        [307],
      );
      const handoff = new URL(browser.headers.get("location")!);
      expect(handoff.pathname).toBe("/connectors/slack/callback");
      expect(handoff.searchParams.get("integration")).toBe("slack");
      expect(handoff.searchParams.get("state")).toBe(state);
      expect(browser.headers.get("cache-control")).toBe("no-store");
      authenticateCallbackActor(context, actor);
      await expect(
        readIntegrationStatus(actor.orgId!, actor.userId),
      ).resolves.toMatchObject({ isInstalled: false, isConnected: false });
      const completion = await accept(
        callbackClient().callback({
          query: { ...query, responseMode: "json" },
          extraHeaders: callbackBrowserHeaders(context, mode, actor),
        }),
        [200, 401],
      );
      expect(completion.status).toBe(callbackNeedsSignIn(mode) ? 401 : 200);
      expect(completion.headers.get("cache-control")).toBe("no-store");
      expect(completion.headers.get("referrer-policy")).toBe("no-referrer");
      if (completion.status === 200) {
        const target = new URL(completion.body.redirectUrl);
        if (mode === "matching-cookie") {
          expect(target.searchParams.get("status")).toBe("connected");
        } else {
          expect(target.searchParams.get("error")).toContain(
            "active account or organization changed",
          );
        }
      }
      authenticateCallbackActor(context, actor);
      await expect(
        readIntegrationStatus(actor.orgId!, actor.userId),
      ).resolves.toMatchObject({
        isInstalled: mode === "matching-cookie",
        isConnected: mode === "matching-cookie",
      });
      if (callbackNeedsSignIn(mode)) {
        const resumed = await accept(
          callbackClient().callback({
            query,
            extraHeaders: { authorization: "Bearer clerk-session" },
          }),
          [307],
        );
        expect(
          new URL(resumed.headers.get("location")!).searchParams.get("status"),
        ).toBe("connected");
        await expect(
          readIntegrationStatus(actor.orgId!, actor.userId),
        ).resolves.toMatchObject({ isInstalled: true, isConnected: true });
      }
    },
  );
  it.each(["missing", "expired-cookie"] as const)(
    "defers legacy Slack user connection until authentication (%s)",
    async (mode) => {
      const installation = await installPublicOrg();
      mockCallbackDirectory(installation.actor);
      const state = await startPublicCallback(installation);
      const victimUser = uniqueSlackUserId();
      mockOAuthSuccess({
        teamId: installation.slackWorkspaceId,
        authedUserId: victimUser,
      });
      const query = { state, code: "provider-user-result" };
      const browser = await accept(callbackClient().callback({ query }), [307]);
      expect(
        new URL(browser.headers.get("location")!).searchParams.get(
          "integration",
        ),
      ).toBe("slack");
      const refused = await accept(
        callbackClient().callback({
          query: { ...query, responseMode: "json" },
          extraHeaders: callbackBrowserHeaders(
            context,
            mode,
            installation.actor,
          ),
        }),
        [401],
      );
      expect(refused.body.error.code).toBe("UNAUTHORIZED");
      authenticateCallbackActor(context, installation.actor);
      await expect(
        readIntegrationStatus(installation.orgId, installation.userId),
      ).resolves.toMatchObject({ isConnected: false });
      const completed = await accept(
        callbackClient().callback({
          query,
          extraHeaders: { authorization: "Bearer clerk-session" },
        }),
        [307],
      );
      expect(
        new URL(completed.headers.get("location")!).searchParams.get("status"),
      ).toBe("connected");
    },
  );
});
