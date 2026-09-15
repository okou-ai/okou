import { Buffer } from "node:buffer";

import type { z } from "zod";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import {
  cliAuthTestCodexOauthContract,
  cliAuthTestConnectorContract,
  cliAuthTestEnableConnectorContract,
  cliAuthTestTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth-test";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  type DesktopAuthCallbackScheme,
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@okouai/api-contracts/contracts/desktop-auth";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import {
  type ClaudeCodeDeviceAuthScope,
  claudeCodeDeviceAuthContract,
} from "@okouai/api-contracts/contracts/claude-code-device-auth";
import {
  type CodexDeviceAuthScope,
  codexDeviceAuthContract,
} from "@okouai/api-contracts/contracts/codex-device-auth";
import { modelProvidersByTypeContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { http, HttpResponse } from "msw";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import type { RouteEntry } from "../../../route-entry";
import { authMeRoutes } from "../../auth-me";
import { cliAuthRoutes } from "../../cli-auth";
import { cliAuthTestRoutes } from "../../cli-auth-test";
import { desktopAuthRoutes } from "../../desktop-auth";
import { agentsRoutes } from "../../agents";
import { billingStatusRoutes } from "../../billing-status";
import { claudeCodeDeviceAuthRoutes } from "../../claude-code-device-auth";
import { codexDeviceAuthRoutes } from "../../codex-device-auth";
import { modelProvidersRoutes } from "../../model-providers";
import { realtimeTokenRoutes } from "../../realtime-token";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

interface CliApproveBody {
  readonly device_code: string;
  readonly timezone?: string;
}

interface TestEmailQuery {
  readonly email?: string;
}

type SeedTestConnectorBody = z.infer<
  (typeof cliAuthTestConnectorContract.create)["body"]
>;
type SeedTestEnableConnectorBody = z.infer<
  (typeof cliAuthTestEnableConnectorContract.create)["body"]
>;
type SeedTestCodexOauthBody = z.infer<
  (typeof cliAuthTestCodexOauthContract.create)["body"]
>;
const authDeviceRoutes: readonly RouteEntry[] = [
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...cliAuthTestRoutes,
  ...desktopAuthRoutes,
  ...agentsRoutes,
  ...billingStatusRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...codexDeviceAuthRoutes,
  ...modelProvidersRoutes,
  ...realtimeTokenRoutes,
];

function authDeviceApp(context: TestContext) {
  return setupAppWithRoutes({
    context,
    routes: authDeviceRoutes,
  });
}

function authDeviceRawApp(context: TestContext) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: authDeviceRoutes,
  });
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function clerkUserProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Auth",
  };
}

function clerkMemberships(actor: ApiTestUser) {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      role: actor.orgRole ?? "org:member",
      organization: {
        id: actor.orgId,
        slug: actor.orgId.toLowerCase(),
        name: "BDD Auth Device Org",
      },
      publicUserData: { userId: actor.userId },
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  ];
}

function setClerkReads(context: TestContext, actor: ApiTestUser): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(actor)],
  });
  const memberships = clerkMemberships(actor);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
}

function codeFromCallbackUrl(callbackUrl: string): string {
  return new URL(callbackUrl).searchParams.get("code") ?? "";
}

function handoffIdFromCallbackUrl(callbackUrl: string): string {
  return new URL(callbackUrl).searchParams.get("handoffId") ?? "";
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function makeCodexJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

type CodexWorkspaceClaim =
  | "organization.title"
  | "workspace.name"
  | "chatgpt_workspace_name";

function makeCodexIdToken(opts: {
  readonly accountId: string | null;
  readonly planType: string | null;
  readonly workspaceName: string | null;
  readonly workspaceClaim?: CodexWorkspaceClaim;
  readonly exp?: number | null;
}): string {
  const auth: Record<string, unknown> = {};
  if (opts.accountId !== null) {
    auth.chatgpt_account_id = opts.accountId;
  }
  if (opts.planType !== null) {
    auth.chatgpt_plan_type = opts.planType;
  }
  if (opts.workspaceName !== null) {
    switch (opts.workspaceClaim ?? "organization.title") {
      case "organization.title": {
        auth.organization = { title: opts.workspaceName };
        break;
      }
      case "workspace.name": {
        auth.workspace = { name: opts.workspaceName };
        break;
      }
      case "chatgpt_workspace_name": {
        auth.chatgpt_workspace_name = opts.workspaceName;
        break;
      }
    }
  }

  const payload: Record<string, unknown> = {
    "https://api.openai.com/auth": auth,
  };
  const exp =
    opts.exp === undefined ? Math.floor(now() / 1000) + 3600 : opts.exp;
  if (exp !== null) {
    payload.exp = exp;
  }
  return makeCodexJwt(payload);
}

function makeCodexTokenResponse(
  scope: "org" | "personal",
  args: {
    readonly accessTokenExpiresAt?: number;
    readonly accountId?: string;
    readonly refreshToken?: string;
    readonly workspaceName?: string;
  } = {},
) {
  const accountId = args.accountId ?? `ws_acct_from_id_token_${scope}`;
  return {
    access_token: makeCodexJwt({
      exp: args.accessTokenExpiresAt ?? Math.floor(now() / 1000) + 7200,
      account_id: accountId,
    }),
    refresh_token: args.refreshToken ?? `rt_${scope}_synthetic_high_entropy`,
    id_token: makeCodexIdToken({
      accountId,
      planType: "plus",
      workspaceName:
        args.workspaceName ?? (scope === "org" ? "Org Acme" : "Personal Acme"),
    }),
  };
}

export function makeCodexAuthJson(
  args: {
    readonly accessToken?: string;
    readonly accessTokenExpiresAt?: number;
    readonly accountId?: string | null;
    readonly idToken?: string;
    readonly idTokenExpiresAt?: number | null;
    readonly planType?: string | null;
    readonly rawAccountId?: string;
    readonly refreshToken?: string;
    readonly withApiKey?: boolean;
    readonly workspaceClaim?: CodexWorkspaceClaim;
    readonly workspaceName?: string | null;
  } = {},
): string {
  const accountId =
    args.accountId === undefined ? "ws_acct_id_token" : args.accountId;
  const planType = args.planType === undefined ? "plus" : args.planType;
  const workspaceName =
    args.workspaceName === undefined ? "Acme" : args.workspaceName;

  return JSON.stringify({
    OPENAI_API_KEY: args.withApiKey ? "sk-test" : null,
    tokens: {
      access_token:
        args.accessToken ??
        makeCodexJwt({
          exp: args.accessTokenExpiresAt ?? Math.floor(now() / 1000) + 7200,
        }),
      refresh_token:
        args.refreshToken ?? "rt_synthetic_authjson_seed_high_entropy",
      account_id: args.rawAccountId ?? "ws_acct_plain",
      id_token:
        args.idToken ??
        makeCodexIdToken({
          accountId,
          exp: args.idTokenExpiresAt,
          planType,
          workspaceClaim: args.workspaceClaim,
          workspaceName,
        }),
    },
  });
}

interface CodexDeviceAuthProviderRecorder {
  readonly userCode: unknown[];
  readonly deviceToken: unknown[];
  readonly oauthToken: URLSearchParams[];
  readonly oauthTokenResponses: ReturnType<typeof makeCodexTokenResponse>[];
}

export function mockCodexDeviceAuthProvider(
  options: {
    readonly accessTokenExpiresAt?: number;
    readonly refreshedAccessTokenExpiresAt?: number;
    readonly tokenScope?: "org" | "personal";
    readonly accountId?: string;
    readonly refreshToken?: string;
    readonly workspaceName?: string;
  } = {},
): CodexDeviceAuthProviderRecorder {
  const recorded: CodexDeviceAuthProviderRecorder = {
    userCode: [],
    deviceToken: [],
    oauthToken: [],
    oauthTokenResponses: [],
  };

  server.use(
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      async ({ request }) => {
        recorded.userCode.push(await request.json());
        return HttpResponse.json({
          device_auth_id: "device_auth_test",
          user_code: "ABCD-EFGH",
          interval: "5",
        });
      },
    ),
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/token",
      async ({ request }) => {
        recorded.deviceToken.push(await request.json());
        return HttpResponse.json({
          authorization_code: "auth_code_test",
          code_challenge: "code_challenge_test",
          code_verifier: "code_verifier_test",
        });
      },
    ),
    http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
      const rawBody = await request.text();
      const body = request.headers
        .get("content-type")
        ?.includes("application/json")
        ? new URLSearchParams(JSON.parse(rawBody) as Record<string, string>)
        : new URLSearchParams(rawBody);
      recorded.oauthToken.push(body);
      const tokenResponse = makeCodexTokenResponse(
        options.tokenScope ?? "org",
        {
          ...options,
          ...(body.get("grant_type") === "refresh_token" &&
          options.refreshedAccessTokenExpiresAt !== undefined
            ? {
                accessTokenExpiresAt: options.refreshedAccessTokenExpiresAt,
              }
            : {}),
        },
      );
      recorded.oauthTokenResponses.push(tokenResponse);
      return HttpResponse.json(tokenResponse);
    }),
  );

  return recorded;
}

interface ClaudeCodeTokenEndpointRecorder {
  readonly token: unknown[];
  readonly profile: Headers[];
  readonly usage: Headers[];
}

export function mockClaudeCodeTokenEndpoint(
  options: {
    readonly accountEmail?: string;
    readonly organizationName?: string;
  } = {},
): ClaudeCodeTokenEndpointRecorder {
  const accountEmail = options.accountEmail ?? "claude.user@example.com";
  const organizationName =
    options.organizationName ?? "Claude User's Organization";
  const recorded: ClaudeCodeTokenEndpointRecorder = {
    token: [],
    profile: [],
    usage: [],
  };

  server.use(
    http.post(
      "https://platform.claude.com/v1/oauth/token",
      async ({ request }) => {
        recorded.token.push(await request.json());
        return HttpResponse.json({
          access_token: "claude-code-access-token",
          expires_in: 31_536_000,
          scope: "user:profile user:inference",
        });
      },
    ),
    http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
      recorded.profile.push(request.headers);
      return HttpResponse.json({
        account: {
          email: accountEmail,
          has_claude_max: false,
          has_claude_pro: true,
        },
        organization: {
          name: organizationName,
          organization_type: "claude_pro",
          rate_limit_tier: "default_claude_ai",
        },
        application: { name: "Claude Code", slug: "claude-code" },
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", ({ request }) => {
      recorded.usage.push(request.headers);
      return HttpResponse.json({
        rate_limits: {
          five_hour: {
            utilization: 12,
            resets_at: "2030-01-01T05:00:00.000Z",
          },
          seven_day: {
            utilization: 24,
            resets_at: "2030-01-07T00:00:00.000Z",
          },
        },
      });
    }),
  );

  return recorded;
}

export function createAuthDeviceApiActions(context: TestContext) {
  const routeMocks = createRouteMocks(context);

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    setClerkReads(context, actor);
    return authHeaders(actor);
  }

  async function postRawJson(
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const response = await authDeviceRawApp(context).request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      body: contentType.includes("application/json")
        ? await response.json()
        : await response.text(),
    };
  }

  return {
    callbackCode: codeFromCallbackUrl,
    callbackHandoffId: handoffIdFromCallbackUrl,

    mockDesktopSignInToken(token: string): void {
      context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
        token,
      });
    },

    async startCliDevice() {
      const client = authDeviceApp(context)(cliAuthDeviceContract);
      const response = await accept(client.create({ body: {} }), [200]);
      return response.body;
    },

    async requestCliToken(
      deviceCode: string,
      statuses: readonly (200 | 202 | 400 | 500)[],
    ) {
      const client = authDeviceApp(context)(cliAuthTokenContract);
      return await accept(
        client.exchange({ body: { device_code: deviceCode } }),
        statuses,
      );
    },

    async requestCliApproval(
      actor: ApiTestUser | null,
      body: CliApproveBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = authDeviceApp(context)(cliAuthApproveContract);
      return await accept(
        client.approve({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    seedClerkDirectory(actor: ApiTestUser): void {
      setClerkReads(context, actor);
    },

    async requestCliApprovalWithBearer(
      token: string,
      body: CliApproveBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = authDeviceApp(context)(cliAuthApproveContract);
      return await accept(
        client.approve({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },

    async requestTestToken(
      query: TestEmailQuery,
      statuses: readonly (200 | 404)[],
    ) {
      const client = authDeviceApp(context)(cliAuthTestTokenContract);
      return await accept(client.create({ query, body: {} }), statuses);
    },

    async requestTestTokenRaw(headers: Record<string, string> = {}) {
      return await postRawJson(
        "/api/cli/auth/test-token",
        JSON.stringify({}),
        headers,
      );
    },

    async provisionTestOrg(actor: ApiTestUser): Promise<{
      readonly accessToken: string;
      readonly userId: string;
    }> {
      setClerkReads(context, actor);
      const client = authDeviceApp(context)(cliAuthTestTokenContract);
      const response = await accept(
        client.create({ query: { email: actor.email }, body: {} }),
        [200],
      );
      return {
        accessToken: response.body.access_token,
        userId: response.body.user_id,
      };
    },

    async requestTestConnector(
      query: TestEmailQuery,
      body: SeedTestConnectorBody,
      statuses: readonly (200 | 400 | 404)[],
    ) {
      const client = authDeviceApp(context)(cliAuthTestConnectorContract);
      return await accept(client.create({ query, body }), statuses);
    },

    async requestTestConnectorRaw(rawBody: string) {
      return await postRawJson("/api/cli/auth/test-connector", rawBody);
    },

    async requestTestEnableConnector(
      query: TestEmailQuery,
      body: SeedTestEnableConnectorBody,
      statuses: readonly (200 | 400 | 404)[],
    ) {
      const client = authDeviceApp(context)(cliAuthTestEnableConnectorContract);
      return await accept(client.create({ query, body }), statuses);
    },

    async requestTestEnableConnectorRaw(rawBody: string) {
      return await postRawJson("/api/cli/auth/test-enable-connector", rawBody);
    },

    async requestTestCodexOauth(
      query: TestEmailQuery,
      body: SeedTestCodexOauthBody,
      statuses: readonly (200 | 400 | 404)[],
    ) {
      const client = authDeviceApp(context)(cliAuthTestCodexOauthContract);
      return await accept(client.create({ query, body }), statuses);
    },

    async requestTestCodexOauthRaw(rawBody: string) {
      return await postRawJson("/api/cli/auth/test-codex-oauth", rawBody);
    },

    async readUserConnectors(actor: ApiTestUser, agentId: string) {
      const client = authDeviceApp(context)(userConnectorsContract);
      const response = await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async readBillingStatus(actor: ApiTestUser) {
      const client = authDeviceApp(context)(billingStatusContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async readMeWithBearer(
      token: string,
      actor: ApiTestUser,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      setClerkReads(context, actor);
      const client = authDeviceApp(context)(authContract);
      return await accept(
        client.me({ headers: { authorization: `Bearer ${token}` } }),
        statuses,
      );
    },

    async requestDesktopHandoff(
      actor: ApiTestUser | null,
      body: { readonly callbackScheme?: DesktopAuthCallbackScheme } | undefined,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = authDeviceApp(context)(desktopAuthHandoffContract);
      return await accept(
        client.create({ headers: authenticate(actor), body: body ?? {} }),
        statuses,
      );
    },

    async requestDesktopHandoffRaw(actor: ApiTestUser | null, rawBody: string) {
      const headers = authenticate(actor);
      return await postRawJson(
        "/api/desktop-auth/handoff",
        rawBody,
        headers.authorization ? { authorization: headers.authorization } : {},
      );
    },

    async requestDesktopConsume(
      code: string,
      statuses: readonly (200 | 400 | 500)[],
    ) {
      const client = authDeviceApp(context)(desktopAuthConsumeContract);
      return await accept(client.consume({ body: { code } }), statuses);
    },

    async requestDesktopHandoffStatus(
      actor: ApiTestUser | null,
      handoffId: string,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = authDeviceApp(context)(desktopAuthHandoffContract);
      return await accept(
        client.status({
          params: { handoffId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async requestDesktopHandoffComplete(
      actor: ApiTestUser | null,
      handoffId: string,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = authDeviceApp(context)(desktopAuthHandoffContract);
      return await accept(
        client.complete({
          params: { handoffId },
          body: {},
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async requestPlatformRealtimeToken(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 500)[],
    ) {
      const client = authDeviceApp(context)(platformRealtimeTokenContract);
      return await accept(
        client.create({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },

    async requestCodexStart(
      actor: ApiTestUser | null,
      scope: CodexDeviceAuthScope,
      statuses: readonly (200 | 400 | 401 | 403 | 503)[],
      mutation?: {
        readonly mode: "add" | "reconnect";
        readonly modelProviderId?: string;
      },
    ) {
      const client = authDeviceApp(context)(codexDeviceAuthContract);
      return await accept(
        client.start({
          headers: authenticate(actor),
          body: { scope, ...mutation },
        }),
        statuses,
      );
    },

    async requestCodexComplete(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 503)[],
    ) {
      const client = authDeviceApp(context)(codexDeviceAuthContract);
      return await accept(
        client.complete({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async requestCodexCancel(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = authDeviceApp(context)(codexDeviceAuthContract);
      return await accept(
        client.cancel({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async requestClaudeCodeStart(
      actor: ApiTestUser | null,
      scope: ClaudeCodeDeviceAuthScope,
      statuses: readonly (200 | 400 | 401 | 403 | 503)[],
      mutation?: {
        readonly mode: "add" | "reconnect";
        readonly modelProviderId?: string;
      },
    ) {
      const client = authDeviceApp(context)(claudeCodeDeviceAuthContract);
      return await accept(
        client.start({
          headers: authenticate(actor),
          body: { scope, ...mutation },
        }),
        statuses,
      );
    },

    async requestClaudeCodeComplete(
      actor: ApiTestUser | null,
      sessionToken: string,
      authorizationCode: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 503)[],
    ) {
      const client = authDeviceApp(context)(claudeCodeDeviceAuthContract);
      return await accept(
        client.complete({
          headers: authenticate(actor),
          body: { sessionToken, authorizationCode },
        }),
        statuses,
      );
    },

    async requestClaudeCodeCancel(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = authDeviceApp(context)(claudeCodeDeviceAuthContract);
      return await accept(
        client.cancel({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async deleteOrgModelProvider(
      actor: ApiTestUser,
      type: "claude-code-oauth-token" | "codex-oauth-token",
    ): Promise<void> {
      const client = authDeviceApp(context)(modelProvidersByTypeContract);
      await accept(
        client.delete({
          params: { type },
          headers: authenticate(actor),
        }),
        [204],
      );
    },
  };
}
