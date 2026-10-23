import { mockClerkUsers } from "./clerk-users";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomInt } from "node:crypto";

import {
  integrationsGithubContract,
  type GithubConnectUserBody,
  type GithubInstallationResponse,
} from "@okouai/api-contracts/contracts/integrations-github";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../../app-factory";
import { mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { mockClerkMembership } from "./api-bdd-clerk";
import { createRouteMocks } from "./route-test";
import { integrationsGithubRoutes } from "../../integrations-github";
import { githubOauthRoutes } from "../../github-oauth";
import { featureSwitchesRoutes } from "../../feature-switches";

const TEST_APP_ROUTES = Object.freeze([
  ...githubOauthRoutes,
  ...integrationsGithubRoutes,
  ...featureSwitchesRoutes,
]);

const GITHUB_APP_SLUG = "okou-test";
const GITHUB_APP_CLIENT_ID = "github-app-client-id";
const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";

const GITHUB_APP_ID = "123456";
const DEFAULT_TEST_ORIGIN = "http://localhost:3000";

interface GithubBearerAuth {
  readonly bearer: string;
}

type GithubActorAuth = ApiTestUser | GithubBearerAuth | null;

interface RawRouteResponse {
  readonly status: number;
  readonly location: string | null;
  readonly cacheControl: string | null;
  readonly body: unknown;
}

interface RecordedTokenExchange {
  clientId: string | null;
  clientSecret: string | null;
  code: string | null;
  redirectUri: string | null;
  hasRedirectUri: boolean;
  calls: number;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "GitHub",
  };
}

function isBearerAuth(auth: GithubActorAuth): auth is GithubBearerAuth {
  return auth !== null && "bearer" in auth;
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function newRemoteInstallationId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

export function newGithubUserId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

function mockGithubAppEnv(
  args: {
    readonly slug?: boolean;
    readonly credentials?: boolean;
    readonly oauthCredentials?: boolean;
  } = {},
): void {
  mockOptionalEnv(
    "GITHUB_APP_SLUG",
    args.slug === false ? undefined : GITHUB_APP_SLUG,
  );
  if (args.credentials === false) {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
  }
  if (args.oauthCredentials === false) {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);
  }
}

function mockGithubInstallationsList(
  installations: readonly {
    readonly id: string;
    readonly targetId: string;
    readonly login?: string;
    readonly type?: string;
  }[],
): void {
  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json(
        installations.map((installation) => {
          return {
            id: Number(installation.id),
            app_id: Number(GITHUB_APP_ID),
            app_slug: GITHUB_APP_SLUG,
            account: {
              id: Number(installation.targetId),
              login: installation.login ?? "bdd-org",
              type: installation.type ?? "Organization",
            },
          };
        }),
      );
    }),
  );
}

function mockGithubInstallationApi(args: {
  readonly installationId: string;
  readonly targetId: string;
  readonly login?: string;
  readonly type?: string;
  readonly token?: string;
}): void {
  server.use(
    http.get(
      `https://api.github.com/app/installations/${args.installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(args.installationId),
          app_id: Number(GITHUB_APP_ID),
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(args.targetId),
            login: args.login ?? "bdd-org",
            type: args.type ?? "Organization",
          },
        });
      },
    ),
    http.post(
      `https://api.github.com/app/installations/${args.installationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: args.token ?? "ghs_bdd_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

function mockGithubUserOAuthExchange(args: {
  readonly code: string;
  readonly organizationId?: string;
  readonly organizationRole?: "admin" | "member";
  readonly githubUserId: string;
  readonly accessToken?: string;
  readonly login?: string;
}): RecordedTokenExchange {
  const recorded: RecordedTokenExchange = {
    clientId: null,
    clientSecret: null,
    code: null,
    redirectUri: null,
    hasRedirectUri: false,
    calls: 0,
  };
  const accessToken = args.accessToken ?? `gho_bdd_${args.code}`;

  server.use(
    http.get("https://api.github.com/user/memberships/orgs", ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json(
        args.organizationId
          ? [
              {
                state: "active",
                role: args.organizationRole ?? "admin",
                organization: { id: Number(args.organizationId) },
              },
            ]
          : [],
      );
    }),
    http.post("https://github.com/login/oauth/access_token", async (info) => {
      const body = new URLSearchParams(await info.request.text());
      recorded.calls += 1;
      recorded.clientId = body.get("client_id");
      recorded.clientSecret = body.get("client_secret");
      recorded.code = body.get("code");
      recorded.redirectUri = body.get("redirect_uri");
      recorded.hasRedirectUri = body.has("redirect_uri");
      if (body.get("code") !== args.code) {
        return HttpResponse.json(
          { error: "bad_verification_code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: accessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: Number(args.githubUserId),
        login: args.login ?? "octocat",
        email: null,
      });
    }),
  );

  return recorded;
}

export function createGithubBddApi(context: TestContext) {
  const routeMocks = createRouteMocks(context);

  function authenticate(auth: GithubActorAuth): {
    readonly authorization?: string;
  } {
    if (auth === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if (isBearerAuth(auth)) {
      return { authorization: `Bearer ${auth.bearer}` };
    }
    routeMocks.clerk.session(auth.userId, auth.orgId, auth.orgRole);
    mockClerkUsers(context, [clerkUserProfile(auth)]);
    return { authorization: "Bearer clerk-session" };
  }

  function githubClient() {
    return setupApp({ context, routes: integrationsGithubRoutes })(
      integrationsGithubContract,
    );
  }

  async function rawRequest(
    path: string,
    init: {
      readonly method: string;
      readonly origin?: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
    },
  ): Promise<RawRouteResponse> {
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      `${init.origin ?? DEFAULT_TEST_ORIGIN}${path}`,
      {
        method: init.method,
        headers: init.headers,
        body: init.body,
      },
    );
    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      status: response.status,
      location: response.headers.get("location"),
      cacheControl: response.headers.get("cache-control"),
      body,
    };
  }

  async function requestInstall(
    query: string,
    options: {
      readonly auth?: GithubActorAuth;
      readonly origin?: string;
      readonly webOriginHeader?: string;
    } = {},
  ): Promise<RawRouteResponse> {
    return await rawRequest(
      `/api/github/oauth/install${query ? `?${query}` : ""}`,
      {
        method: "GET",
        origin: options.origin,
        headers: {
          ...authenticate(options.auth ?? null),
          ...(options.webOriginHeader
            ? { "x-okou-web-origin": options.webOriginHeader }
            : {}),
        },
      },
    );
  }

  async function requestSetupCallback(
    query: string,
    options: { readonly origin?: string; readonly auth?: GithubActorAuth } = {},
  ): Promise<RawRouteResponse> {
    return await rawRequest(
      `/api/github/app/setup/callback${query ? `?${query}` : ""}`,
      {
        method: "GET",
        origin: options.origin,
        headers:
          options.auth === undefined ? undefined : authenticate(options.auth),
      },
    );
  }

  async function finishInstallationCallback(
    callback: RawRouteResponse,
    args: {
      readonly actor: ApiTestUser;
      readonly installationId: string;
      readonly githubUserId: string;
      readonly organizationId?: string;
    },
  ): Promise<RawRouteResponse> {
    if (callback.location) {
      const replayUrl = new URL(callback.location);
      if (replayUrl.pathname === "/api/github/app/setup/callback") {
        callback = await requestSetupCallback(replayUrl.search.slice(1), {
          origin: replayUrl.origin,
          auth: args.actor,
        });
      }
    }
    if (
      callback.location &&
      new URL(callback.location).pathname === "/login/oauth/authorize"
    ) {
      const authorization = new URL(callback.location);
      const continuationState = authorization.searchParams.get("state");
      if (!continuationState) {
        throw new Error("Expected an installation verification state");
      }
      const code = `verify-install-${args.installationId}`;
      mockGithubUserOAuthExchange({
        code,
        githubUserId: args.githubUserId,
        organizationId: args.organizationId,
      });
      callback = await requestSetupCallback(
        new URLSearchParams({ code, state: continuationState }).toString(),
        {
          origin: new URL(authorization.searchParams.get("redirect_uri")!)
            .origin,
          auth: args.actor,
        },
      );
    }
    return callback;
  }

  return {
    requestInstall,
    requestSetupCallback,
    configureApp: mockGithubAppEnv,
    mockInstallation: mockGithubInstallationApi,
    mockUserAuthorization: mockGithubUserOAuthExchange,

    async readInstallation(
      auth: GithubActorAuth,
    ): Promise<GithubInstallationResponse> {
      const response = await accept(
        githubClient().getInstallation({ headers: authenticate(auth) }),
        [200],
      );
      return response.body;
    },

    async requestReadInstallation<
      TStatus extends 200 | 400 | 401 | 403 | 404 | 500,
    >(
      auth: GithubActorAuth,
      statuses: readonly TStatus[],
      options: { readonly webOriginHeader?: string } = {},
    ) {
      return await accept(
        githubClient().getInstallation({
          headers: authenticate(auth),
          ...(options.webOriginHeader
            ? { extraHeaders: { "x-okou-web-origin": options.webOriginHeader } }
            : {}),
        }),
        statuses,
      );
    },

    async connectUser<TStatus extends 200 | 400 | 401 | 404 | 409 | 500>(
      auth: GithubActorAuth,
      body: GithubConnectUserBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().connectUser({ headers: authenticate(auth), body }),
        statuses,
      );
    },

    async enableAuditLink(actor: ApiTestUser): Promise<void> {
      const client = setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      );
      await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
        }),
        [200],
      );
    },

    /**
     * Composite Given: full GitHub App install through the real install
     * redirect and setup callback. With `oauthCode` set the setup callback
     * exchanges the code against the GitHub App OAuth client and links the
     * installing admin; without it the provider verification continuation leaves the install unlinked.
     */
    async installGithubApp(
      actor: ApiTestUser,
      composeId: string,
      options: {
        readonly oauthCode?: {
          readonly code: string;
          readonly githubUserId: string;
          readonly login?: string;
        };
        readonly beforeCallback?: () => Promise<void>;
        readonly targetType?: string;
        readonly targetLogin?: string;
        readonly installationId?: string;
      } = {},
    ): Promise<{
      readonly remoteInstallationId: string;
      readonly targetId: string;
      readonly state: string;
    }> {
      if (!actor.orgId) {
        throw new Error("GitHub installs require an org-scoped actor");
      }
      mockGithubAppEnv();
      mockClerkMembership(context, actor, "org:admin");
      mockGithubInstallationsList([]);

      const installQuery = new URLSearchParams({
        userId: actor.userId,
        orgId: actor.orgId,
        composeId,
      }).toString();
      const install = await requestInstall(installQuery, {
        origin: "https://api.okou.ai",
        auth: actor,
      });
      if (install.status !== 307 || !install.location) {
        throw new Error(
          `Expected GitHub install redirect, received ${install.status}`,
        );
      }
      const installUrl = new URL(install.location);
      if (installUrl.origin !== "https://github.com") {
        throw new Error(
          `Unexpected install redirect target: ${install.location}`,
        );
      }
      const state = installUrl.searchParams.get("state");
      if (!state) {
        throw new Error(
          "Expected the install redirect to carry a signed state",
        );
      }

      const remoteInstallationId =
        options.installationId ?? newRemoteInstallationId();
      const targetId =
        options.targetType === "User" && options.oauthCode
          ? options.oauthCode.githubUserId
          : newGithubUserId();
      mockGithubInstallationApi({
        installationId: remoteInstallationId,
        targetId,
        login: options.targetLogin ?? "bdd-org",
        type: options.targetType ?? "Organization",
      });
      if (options.oauthCode) {
        mockGithubUserOAuthExchange({
          organizationId: options.targetType === "User" ? undefined : targetId,
          code: options.oauthCode.code,
          githubUserId: options.oauthCode.githubUserId,
          login: options.oauthCode.login,
        });
      }
      await options.beforeCallback?.();

      const callbackQuery = new URLSearchParams({
        installation_id: remoteInstallationId,
        setup_action: "install",
        state,
        ...(options.oauthCode ? { code: options.oauthCode.code } : {}),
      }).toString();
      let callback = await requestSetupCallback(callbackQuery, {
        origin: "https://api.okou.ai",
        auth: actor,
      });
      callback = await finishInstallationCallback(callback, {
        actor,
        installationId: remoteInstallationId,
        githubUserId: targetId,
        organizationId: options.targetType === "User" ? undefined : targetId,
      });
      if (callback.status !== 307 || !callback.location) {
        throw new Error(
          `Expected GitHub setup callback redirect, received ${callback.status}`,
        );
      }
      const redirectUrl = new URL(callback.location);
      if (redirectUrl.pathname !== "/workflows") {
        throw new Error(
          `Expected GitHub setup to finish at /workflows: ${callback.location}`,
        );
      }

      return { remoteInstallationId, targetId, state };
    },
  };
}
