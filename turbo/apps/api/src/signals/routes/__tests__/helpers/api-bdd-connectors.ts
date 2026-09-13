import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import type {
  ConnectorExternalCodeSessionCompleteResponse,
  ConnectorExternalCodeSessionStartResponse,
  ConnectorListResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorOauthStartResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { githubOauthContract } from "@okouai/api-contracts/contracts/github-oauth";
import {
  integrationsGithubContract,
  type GithubInstallationResponse,
} from "@okouai/api-contracts/contracts/integrations-github";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorProposalContract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorPermissionBundleResponse,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
  type SaveCustomConnectorProposalBody,
  type SaveCustomConnectorProposalResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  connectorManualGrantContract,
  connectorExternalCodeSessionContract,
  connectorOauthDeviceAuthSessionContract,
  connectorOauthStartContract,
  connectorScopeDiffContract,
  connectorsBySlugContract,
  connectorsMainContract,
  connectorsSearchContract,
  type ConnectorSearchResponse,
} from "@okouai/api-contracts/contracts/connectors";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createApp } from "../../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { createDeferredPromise } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { connectorsSlugCallbackRoutes } from "../../connectors-slug-callback";
import { githubOauthRoutes } from "../../github-oauth";
import { integrationsGithubRoutes } from "../../integrations-github";
import { agentsRoutes } from "../../agents";
import { connectorAccountRoutes } from "../../connector-accounts";
import { connectorsRoutes } from "../../connectors";
import { connectorsExternalCodeRoutes } from "../../connectors-external-code";
import { connectorsOauthDeviceAuthRoutes } from "../../connectors-oauth-device-auth";
import { customConnectorsRoutes } from "../../custom-connectors";
import { customConnectorsDeleteRoutes } from "../../custom-connectors-delete";
import { customConnectorsGetRoutes } from "../../custom-connectors-get";
import { customConnectorOAuth2Routes } from "../../custom-connectors-oauth2";
import { customConnectorProposalRoutes } from "../../custom-connectors-proposal";
import { customConnectorsUpdateRoutes } from "../../custom-connectors-update";
import { customConnectorsValuesSetRoutes } from "../../custom-connectors-values-set";
import { featureSwitchesRoutes } from "../../feature-switches";

const customConnectorByIdTestRoutes = Object.freeze([
  ...customConnectorsDeleteRoutes,
  ...customConnectorsGetRoutes,
  ...customConnectorsUpdateRoutes,
]);

const TEST_APP_ROUTES = Object.freeze([
  ...connectorsSlugCallbackRoutes,
  ...githubOauthRoutes,
  ...integrationsGithubRoutes,
  ...agentsRoutes,
  ...connectorAccountRoutes,
  ...connectorsExternalCodeRoutes,
  ...connectorsOauthDeviceAuthRoutes,
  ...connectorsRoutes,
  ...customConnectorsRoutes,
  ...featureSwitchesRoutes,
]);

interface AuthHeaders {
  readonly authorization?: string;
}

type HttpCreateCustomConnectorBody = Exclude<
  CreateCustomConnectorBody,
  { readonly kind: "mcp" }
>;

export function manualHttpCustomConnectorCreateBody(args: {
  readonly displayName: string;
  readonly prefixTemplates: readonly string[];
  readonly slug?: string;
  readonly permissionBundleRef?: HttpCreateCustomConnectorBody["permissionBundleRef"];
  readonly skillMarkdown?: HttpCreateCustomConnectorBody["skillMarkdown"];
}): HttpCreateCustomConnectorBody {
  return {
    displayName: args.displayName,
    prefixTemplates: [...args.prefixTemplates],
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
        description: "API credential",
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    ...(args.slug === undefined ? {} : { slug: args.slug }),
    ...(args.permissionBundleRef === undefined
      ? {}
      : { permissionBundleRef: args.permissionBundleRef }),
    ...(args.skillMarkdown === undefined
      ? {}
      : { skillMarkdown: args.skillMarkdown }),
  };
}

type CallbackQuery = {
  readonly code?: string;
  readonly state?: string;
  readonly domain?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly iss?: string;
};

interface RequestBaseUrlOptions {
  readonly baseUrl?: string;
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const DATADOG_US3_TOKEN_URL = "https://api.us3.datadoghq.com/oauth2/v1/token";
const TEST_OAUTH_DEVICE_CODE_URL =
  "http://localhost:3000/api/test/oauth-provider/device/code";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const BASE44_DEVICE_CODE_URL = "https://app.base44.com/oauth/device/code";
const BASE44_TOKEN_URL = "https://app.base44.com/oauth/token";
const BASE44_USERINFO_URL = "https://app.base44.com/oauth/userinfo";
const SLOCK_DEVICE_CODE_URL = "https://api.slock.ai/api/auth/device/authorize";
const SLOCK_TOKEN_URL = "https://api.slock.ai/api/auth/device/token";
const SLOCK_USERINFO_URL = "https://api.slock.ai/api/auth/me";
const SLOCK_SERVERS_URL = "https://api.slock.ai/api/servers";
const STRIPE_OAUTH_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";
const STRIPE_CLI_AUTH_URL = "https://dashboard.stripe.com/stripecli/auth";
const STRIPE_CLI_BROWSER_URL =
  "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI";
const STRIPE_CLI_POLL_URL =
  "https://dashboard.stripe.com/stripecli/auth/poll-session";
const TEST_OAUTH_USERINFO_URL =
  "http://localhost:3000/api/test/oauth-provider/userinfo";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_OAUTH_USER_INFO_URL = "https://slack.com/api/users.info";
const GITHUB_APP_INSTALLATIONS_URL = "https://api.github.com/app/installations";
const GITHUB_APP_SLUG = "bdd-github-app";
const CUSTOM_CONNECTOR_OAUTH2_AUTHORIZATION_URL =
  "https://custom-oauth.example.test/authorize";
const CUSTOM_CONNECTOR_OAUTH2_TOKEN_URL =
  "https://custom-oauth.example.test/token";

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function expectStatus<
  TResponse extends { readonly status: number },
  TStatus extends TResponse["status"],
>(
  response: TResponse,
  status: TStatus,
): asserts response is Extract<TResponse, { readonly status: TStatus }> {
  if (response.status !== status) {
    throw new Error(`Expected status ${status}, got ${response.status}`);
  }
}

interface CustomConnectorOAuth2ProviderRecorder {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly tokenBodies: URLSearchParams[];
  readonly authorizationHeaders: (string | null)[];
}

interface CustomConnectorOAuth2ProviderOptions {
  readonly initialExpiresIn?: number;
  readonly authorizationCodeScopes?: readonly string[];
  readonly initialRefreshToken?: string | null;
  readonly initialScope?: string;
  readonly refreshResponse?: (attempt: number) => Response | Promise<Response>;
}

export function mockCustomConnectorOAuth2Provider(
  context: TestContext,
  options: CustomConnectorOAuth2ProviderOptions = {},
): CustomConnectorOAuth2ProviderRecorder {
  context.mocks.dns.lookupOverrides.set("custom-oauth.example.test", [
    { address: "93.184.216.34", family: 4 },
  ]);
  const tokenBodies: URLSearchParams[] = [];
  const authorizationHeaders: (string | null)[] = [];
  const initialRefreshToken =
    options.initialRefreshToken === undefined
      ? "custom-oauth-refresh-token"
      : options.initialRefreshToken;
  let refreshAttempts = 0;
  server.use(
    http.post(CUSTOM_CONNECTOR_OAUTH2_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      tokenBodies.push(body);
      authorizationHeaders.push(request.headers.get("authorization"));
      if (body.get("grant_type") === "refresh_token") {
        refreshAttempts += 1;
        if (options.refreshResponse) {
          return await options.refreshResponse(refreshAttempts);
        }
        return HttpResponse.json({
          access_token: "custom-oauth-refreshed-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return HttpResponse.json({
        access_token: "custom-oauth-initial-access-token",
        ...(initialRefreshToken === null
          ? {}
          : { refresh_token: initialRefreshToken }),
        id_token: "custom-oauth-id-token",
        token_type: "Bearer",
        expires_in: options.initialExpiresIn ?? 0,
        ...(options.initialScope === undefined
          ? {}
          : { scope: options.initialScope }),
      });
    }),
  );
  return {
    authorizationUrl: CUSTOM_CONNECTOR_OAUTH2_AUTHORIZATION_URL,
    tokenUrl: CUSTOM_CONNECTOR_OAUTH2_TOKEN_URL,
    tokenBodies,
    authorizationHeaders,
  };
}

interface AutomaticMcpOAuthProviderOptions {
  readonly registration: "cimd" | "dcr" | "none";
  readonly authentication?: "invalid" | "none" | "oauth";
  readonly issuerParameterSupported?: boolean;
  readonly dcrTokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  readonly synchronizeAuthorizationServerDiscovery?: boolean;
  readonly dcrFailureStatus?: number;
  readonly dcrFailureDescription?: string;
  readonly invalidDcrResponse?: boolean;
  readonly authorizationCodeSupported?: boolean;
  readonly pkceS256Supported?: boolean;
  readonly discovery?: "challenge" | "well-known-oidc";
  readonly resourceMetadataStatus?: number;
  readonly challengeScope?: string | null;
  readonly metadataScopes?: readonly string[];
  readonly authorizationCodeScopes?: readonly string[];
  readonly refreshError?:
    | "invalid_client"
    | "invalid_grant"
    | "temporarily_unavailable";
  readonly refreshErrors?: readonly (
    | "invalid_client"
    | "invalid_grant"
    | "temporarily_unavailable"
  )[];
  readonly refreshResponse?: (attempt: number) => Response | Promise<Response>;
  readonly initialExpiresIn?: number;
  readonly initialRefreshToken?: string;
  readonly resource?: string;
  readonly authorizationEndpoint?: string;
  readonly metadataIssuer?: string;
}

interface AutomaticMcpOAuthProviderRecorder {
  readonly endpoint: string;
  readonly issuer: string;
  readonly registrationBodies: readonly Record<string, unknown>[];
  advertiseAuthorizationServers(issuers: readonly string[]): void;
  setChallengeScope(scope: string | null): void;
  authorizationServerDiscoveryCalls(): number;
  readonly tokenBodies: readonly URLSearchParams[];
  readonly tokenAuthorizationHeaders: readonly (string | null)[];
}

const automaticDcrRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  scope: z.string().optional(),
});

export function mockAutomaticMcpOAuthProvider(
  context: TestContext,
  options: AutomaticMcpOAuthProviderOptions,
): AutomaticMcpOAuthProviderRecorder {
  const endpoint = "https://automatic-mcp.example.test/server";
  const resourceMetadataUrl =
    "https://automatic-mcp.example.test/oauth-resource";
  const issuer = "https://automatic-issuer.example.test";
  const authorizationUrl = `${issuer}/authorize`;
  const tokenUrl = `${issuer}/token`;
  const registrationUrl = `${issuer}/register`;
  const resourceMetadata = {
    resource: options.resource ?? endpoint,
    scopes_supported: [...(options.metadataScopes ?? ["metadata-fallback"])],
  };
  const tokenEndpointAuthMethod =
    options.dcrTokenEndpointAuthMethod ?? "client_secret_basic";
  const authorizationServerMetadata = {
    issuer: options.metadataIssuer ?? issuer,
    authorization_endpoint: options.authorizationEndpoint ?? authorizationUrl,
    token_endpoint: tokenUrl,
    response_types_supported:
      options.authorizationCodeSupported === false ? ["token"] : ["code"],
    grant_types_supported:
      options.authorizationCodeSupported === false
        ? ["refresh_token"]
        : ["authorization_code", "refresh_token"],
    code_challenge_methods_supported:
      options.pkceS256Supported === false ? ["plain"] : ["S256"],
    token_endpoint_auth_methods_supported:
      options.registration === "dcr" ? [tokenEndpointAuthMethod] : ["none"],
    authorization_response_iss_parameter_supported:
      options.issuerParameterSupported ?? true,
    client_id_metadata_document_supported: options.registration === "cimd",
    ...(options.registration === "dcr"
      ? { registration_endpoint: registrationUrl }
      : {}),
  };
  for (const hostname of [
    "automatic-mcp.example.test",
    "automatic-issuer.example.test",
  ]) {
    context.mocks.dns.lookupOverrides.set(hostname, [
      { address: "93.184.216.34", family: 4 },
    ]);
  }
  const registrationBodies: Record<string, unknown>[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const tokenAuthorizationHeaders: (string | null)[] = [];
  let authorizationServerDiscoveryCallCount = 0;
  let advertisedAuthorizationServers: readonly string[] = [issuer];
  let challengeScope =
    options.challengeScope === undefined
      ? "read write"
      : options.challengeScope;
  let refreshAttempts = 0;
  let authorizationCodeAttempts = 0;
  const authorizationServerDiscoveryBarrier =
    options.synchronizeAuthorizationServerDiscovery
      ? createDeferredPromise<void>(AbortSignal.any([]))
      : null;
  if (authorizationServerDiscoveryBarrier) {
    onTestFinished(() => {
      if (!authorizationServerDiscoveryBarrier.settled()) {
        authorizationServerDiscoveryBarrier.resolve(undefined);
      }
    });
  }
  const recordAuthorizationServerDiscovery = async (): Promise<void> => {
    authorizationServerDiscoveryCallCount += 1;
    if (
      authorizationServerDiscoveryBarrier &&
      authorizationServerDiscoveryCallCount >= 2 &&
      !authorizationServerDiscoveryBarrier.settled()
    ) {
      authorizationServerDiscoveryBarrier.resolve(undefined);
    }
    if (authorizationServerDiscoveryBarrier) {
      await authorizationServerDiscoveryBarrier.promise;
    }
  };
  server.use(
    http.get(endpoint, () => {
      return new HttpResponse(null, {
        status: 405,
        headers: { allow: "POST" },
      });
    }),
    http.post(endpoint, async ({ request }) => {
      if (options.authentication === "invalid") {
        return new HttpResponse(null, { status: 403 });
      }
      if (options.authentication === "none") {
        const body = z
          .object({
            jsonrpc: z.literal("2.0"),
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string(),
          })
          .passthrough()
          .parse(await request.json());
        if (body.method !== "initialize" || body.id === undefined) {
          return new HttpResponse(null, { status: 202 });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "BDD no-auth MCP", version: "1.0.0" },
          },
        });
      }
      const resourceMetadataParameter =
        options.discovery === "well-known-oidc"
          ? ""
          : ` resource_metadata="${resourceMetadataUrl}",`;
      return new HttpResponse(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer${resourceMetadataParameter}${
            challengeScope === null ? "" : ` scope="${challengeScope}"`
          }`,
        },
      });
    }),
    http.get(resourceMetadataUrl, () => {
      return options.resourceMetadataStatus
        ? HttpResponse.json(
            { error: "resource_metadata_unavailable" },
            { status: options.resourceMetadataStatus },
          )
        : HttpResponse.json({
            ...resourceMetadata,
            authorization_servers: [...advertisedAuthorizationServers],
          });
    }),
    http.get(
      "https://automatic-mcp.example.test/.well-known/oauth-protected-resource/server",
      () => {
        return new HttpResponse(null, { status: 404 });
      },
    ),
    http.get(
      "https://automatic-mcp.example.test/.well-known/oauth-protected-resource",
      () => {
        return options.resourceMetadataStatus
          ? HttpResponse.json(
              { error: "resource_metadata_unavailable" },
              { status: options.resourceMetadataStatus },
            )
          : HttpResponse.json({
              ...resourceMetadata,
              authorization_servers: [...advertisedAuthorizationServers],
            });
      },
    ),
    http.get(`${issuer}/.well-known/oauth-authorization-server`, async () => {
      await recordAuthorizationServerDiscovery();
      return options.discovery === "well-known-oidc"
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json(authorizationServerMetadata);
    }),
    http.get(`${issuer}/.well-known/openid-configuration`, async () => {
      await recordAuthorizationServerDiscovery();
      return HttpResponse.json({
        ...authorizationServerMetadata,
        jwks_uri: `${issuer}/jwks.json`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),
    http.post(registrationUrl, async ({ request }) => {
      const body = automaticDcrRequestSchema.parse(await request.json());
      registrationBodies.push(body);
      if (options.dcrFailureStatus) {
        return HttpResponse.json(
          {
            error:
              options.dcrFailureStatus >= 500
                ? "temporarily_unavailable"
                : "invalid_client_metadata",
            ...(options.dcrFailureDescription
              ? { error_description: options.dcrFailureDescription }
              : {}),
          },
          { status: options.dcrFailureStatus },
        );
      }
      if (options.invalidDcrResponse) {
        return HttpResponse.json({ ...body, client_id: "" });
      }
      return HttpResponse.json({
        ...body,
        client_id: "automatic-dcr-client",
        ...(tokenEndpointAuthMethod === "none"
          ? {}
          : { client_secret: "automatic-dcr-secret" }),
        client_id_issued_at: Math.floor(now() / 1000),
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      });
    }),
    http.post(tokenUrl, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      tokenBodies.push(body);
      tokenAuthorizationHeaders.push(request.headers.get("authorization"));
      const refresh = body.get("grant_type") === "refresh_token";
      if (refresh) {
        refreshAttempts += 1;
        if (options.refreshResponse) {
          return await options.refreshResponse(refreshAttempts);
        }
      } else {
        authorizationCodeAttempts += 1;
      }
      const refreshError = refresh
        ? (options.refreshErrors?.[refreshAttempts - 1] ?? options.refreshError)
        : undefined;
      if (refreshError) {
        return HttpResponse.json(
          { error: refreshError },
          {
            status: refreshError === "temporarily_unavailable" ? 503 : 400,
          },
        );
      }
      return HttpResponse.json({
        access_token: refresh
          ? "automatic-refreshed-access-token"
          : "automatic-initial-access-token",
        ...(!refresh
          ? {
              refresh_token:
                options.initialRefreshToken ?? "automatic-refresh-token",
            }
          : {}),
        token_type: "Bearer",
        expires_in: refresh ? 3600 : (options.initialExpiresIn ?? 0),
        scope:
          options.authorizationCodeScopes?.[authorizationCodeAttempts - 1] ??
          "read write",
      });
    }),
  );
  return {
    endpoint,
    issuer,
    registrationBodies,
    advertiseAuthorizationServers(issuers: readonly string[]): void {
      advertisedAuthorizationServers = [...issuers];
    },
    setChallengeScope(scope: string | null): void {
      challengeScope = scope;
    },
    authorizationServerDiscoveryCalls: () => {
      return authorizationServerDiscoveryCallCount;
    },
    tokenBodies,
    tokenAuthorizationHeaders,
  };
}

export function mockGitHubConnectorOAuth(
  options: {
    readonly userId?: number;
    readonly login?: string;
    readonly email?: string | null;
  } = {},
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");

  server.use(
    http.post(GITHUB_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "missing-code";
      return HttpResponse.json({
        access_token: `github-access-${code}`,
        scope: "repo,project,workflow",
      });
    }),
    http.get(GITHUB_USER_URL, () => {
      return HttpResponse.json({
        id: options.userId ?? 42,
        login: options.login ?? "bdd-github-user",
        email:
          options.email === undefined
            ? "bdd-github@example.test"
            : options.email,
      });
    }),
  );
}

interface StripeConnectorOAuthOptions {
  readonly accountId?: string;
  readonly livemode?: boolean;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

interface StripeConnectorOAuthRecorder {
  readonly tokenBodies: URLSearchParams[];
  readonly tokenAuthorizationHeaders: (string | null)[];
  readonly accountAuthorizationHeaders: (string | null)[];
}

export function mockStripeConnectorOAuth(
  options: StripeConnectorOAuthOptions = {},
): StripeConnectorOAuthRecorder {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_ID", "stripe-client-id");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_SECRET", "sk_test_marketplace_secret");

  const tokenBodies: URLSearchParams[] = [];
  const tokenAuthorizationHeaders: (string | null)[] = [];
  const accountAuthorizationHeaders: (string | null)[] = [];
  const accessToken = options.accessToken ?? "stripe-live-access-token";
  const accountId = options.accountId ?? "acct_live_workflow";
  server.use(
    http.post(STRIPE_OAUTH_TOKEN_URL, async ({ request }) => {
      tokenBodies.push(new URLSearchParams(await request.text()));
      tokenAuthorizationHeaders.push(request.headers.get("authorization"));
      return HttpResponse.json({
        access_token: accessToken,
        livemode: options.livemode ?? true,
        refresh_token: options.refreshToken ?? "stripe-refresh-token",
        stripe_user_id: accountId,
        scope: "stripe_apps",
      });
    }),
    http.get(STRIPE_ACCOUNT_URL, ({ request }) => {
      accountAuthorizationHeaders.push(request.headers.get("authorization"));
      return HttpResponse.json({
        id: accountId,
        business_profile: { name: "BDD Stripe Account" },
        email: "stripe-workflow@example.test",
      });
    }),
  );
  return {
    tokenBodies,
    tokenAuthorizationHeaders,
    accountAuthorizationHeaders,
  };
}

interface DatadogOAuthProviderRecorder {
  readonly tokenBodies: URLSearchParams[];
}

export function mockDatadogConnectorOAuth(): DatadogOAuthProviderRecorder {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("DATADOG_OAUTH_CLIENT_ID", "datadog-client-id");
  mockOptionalEnv("DATADOG_OAUTH_CLIENT_SECRET", "datadog-client-secret");

  const tokenBodies: URLSearchParams[] = [];
  server.use(
    http.post(DATADOG_US3_TOKEN_URL, async ({ request }) => {
      tokenBodies.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: "bdd-datadog-access-token",
        refresh_token: "bdd-datadog-refresh-token",
        expires_in: 3600,
        scope: "dashboards_read logs_read_index_data",
      });
    }),
  );

  return { tokenBodies };
}

interface TestOAuthAuthCodeProviderOptions {
  readonly accessToken?: string;
  readonly refreshToken?: string | null;
  readonly expiresIn?: number;
  readonly omitExpiresIn?: boolean;
  readonly scope?: string | null;
  readonly tokenError?: boolean;
  readonly userinfoError?: boolean;
  readonly userId?: string;
  readonly username?: string;
  readonly email?: string;
}

interface TestOAuthAuthCodeProviderRecorder {
  readonly tokenBodies: URLSearchParams[];
}

/**
 * Provider boundary for the test-oauth auth-code connector. The connector's
 * exchange/userinfo URLs resolve from process.env to http://localhost:3000,
 * matching the device-auth fixtures above. refreshToken null/omitted leaves
 * refresh_token out of the token response, and scope null leaves scope out.
 */
export function mockTestOAuthAuthCodeProvider(
  options: TestOAuthAuthCodeProviderOptions = {},
): TestOAuthAuthCodeProviderRecorder {
  const recorded: TestOAuthAuthCodeProviderRecorder = { tokenBodies: [] };

  server.use(
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      recorded.tokenBodies.push(new URLSearchParams(await request.text()));
      if (options.tokenError) {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Synthetic token exchange failure",
          },
          { status: 400 },
        );
      }
      const refreshToken = options.refreshToken ?? null;
      return HttpResponse.json({
        access_token: options.accessToken ?? "bdd-test-oauth-access-token",
        ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
        ...(options.omitExpiresIn
          ? {}
          : { expires_in: options.expiresIn ?? 3600 }),
        token_type: "Bearer",
        ...(options.scope === null ? {} : { scope: options.scope ?? "read" }),
      });
    }),
    http.get(TEST_OAUTH_USERINFO_URL, () => {
      if (options.userinfoError) {
        return HttpResponse.json(
          { error: "userinfo_lookup_failed" },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        id: options.userId ?? "bdd-test-oauth-user",
        username: options.username ?? "bdd-test-oauth",
        email: options.email ?? "bdd-test-oauth@example.test",
      });
    }),
  );

  return recorded;
}

/**
 * Slack user-OAuth provider boundary used for the null-token-expiry arm:
 * the slack oauth method has static (non-refreshable) access, so a stored
 * token has no expiry.
 */
export function mockSlackConnectorOAuth(): void {
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-client-secret");

  server.use(
    http.post(SLACK_OAUTH_TOKEN_URL, () => {
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: "xoxp-bdd-user-token",
          scope: "channels:read,chat:write",
        },
      });
    }),
    http.get(SLACK_OAUTH_USER_INFO_URL, () => {
      return HttpResponse.json({
        ok: true,
        user: {
          id: "U012AB3CD",
          name: "bddslack",
          real_name: "BDD Slack User",
          profile: { email: "bdd-slack@example.test" },
        },
      });
    }),
  );
}

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_OPENID_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

interface GoogleDriveConnectorOAuthOptions {
  /**
   * Omit refresh_token from the authorization-code exchange so the stored
   * connector has no refresh path (Drive 401s then resolve to "unknown").
   */
  readonly omitRefreshToken?: boolean;
  readonly userInfo?: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
  readonly refreshOutcome?:
    | { readonly type: "ok"; readonly accessToken: string }
    | { readonly type: "server-error" }
    | {
        readonly type: "invalid-grant";
        readonly errorSubtype?: string;
      };
}

interface GoogleDriveConnectorOAuthRecorder {
  readonly refreshBodies: URLSearchParams[];
}

/**
 * Google Drive connector OAuth provider boundary: env client credentials,
 * the oauth2 token endpoint with configurable refresh outcomes, and the
 * Google userinfo endpoint.
 */
export function mockGoogleDriveConnectorOAuth(
  options: GoogleDriveConnectorOAuthOptions = {},
): GoogleDriveConnectorOAuthRecorder {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  const recorded: GoogleDriveConnectorOAuthRecorder = { refreshBodies: [] };

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        recorded.refreshBodies.push(body);
        const outcome = options.refreshOutcome ?? {
          type: "invalid-grant",
        };
        if (outcome.type === "ok") {
          return HttpResponse.json({
            access_token: outcome.accessToken,
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (outcome.type === "server-error") {
          return HttpResponse.json(
            {
              error: "server_error",
              error_description: "Temporary Google OAuth failure",
            },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
            ...(outcome.errorSubtype === undefined
              ? {}
              : { error_subtype: outcome.errorSubtype }),
          },
          { status: 400 },
        );
      }
      const code = body.get("code") ?? "missing-code";
      return HttpResponse.json({
        access_token: `drive-access-${code}`,
        ...(options.omitRefreshToken
          ? {}
          : { refresh_token: `drive-refresh-${code}` }),
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get(GOOGLE_USERINFO_URL, () => {
      return HttpResponse.json(
        options.userInfo ?? {
          id: "bdd-drive-user-id",
          email: "bdd-drive@example.test",
          name: "BDD Drive User",
        },
      );
    }),
  );
  return recorded;
}

interface GmailConnectorOAuthOptions {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly subject?: string;
  readonly email?: string;
}

export function mockGmailConnectorOAuth(
  options: GmailConnectorOAuthOptions = {},
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
          },
          { status: 400 },
        );
      }

      return HttpResponse.json({
        access_token: options.accessToken ?? "gmail-access-token",
        refresh_token: options.refreshToken ?? "gmail-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }),
    http.get(GOOGLE_OPENID_USERINFO_URL, () => {
      const email = options.email ?? "bdd-gmail@example.test";
      return HttpResponse.json({
        sub: options.subject ?? "bdd-gmail-user-id",
        email,
        name: "BDD Gmail User",
      });
    }),
  );
}

export function mockGoogleFormsConnectorOAuth(
  options: {
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly subject?: string;
    readonly email?: string;
  } = {},
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "google-forms-access-token",
        refresh_token: options.refreshToken ?? "google-forms-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/forms.body.readonly https://www.googleapis.com/auth/forms.responses.readonly",
      });
    }),
    http.get(GOOGLE_USERINFO_URL, () => {
      return HttpResponse.json({
        id: options.subject ?? "bdd-google-forms-user-id",
        email: options.email ?? "bdd-google-forms@example.test",
        name: "BDD Google Forms User",
      });
    }),
  );
}

interface GoogleDriveFileFixture {
  readonly id: string;
  readonly name: string;
  readonly webViewLink?: string | null;
  readonly appProperties?: Readonly<Record<string, string>>;
}

type GoogleDriveFilesListResponse =
  | { readonly status: 200; readonly files: readonly GoogleDriveFileFixture[] }
  | { readonly status: 401 | 500 };

interface GoogleDriveFilesListRecorder {
  readonly authorizationHeaders: (string | null)[];
  readonly queries: string[];
}

/**
 * Thin recorder over GET https://www.googleapis.com/drive/v3/files: every
 * call records the `q` search expression and answers with the fixture's
 * response. Handlers resolve immediately — the artifact status lookup runs
 * under an AbortSignal.timeout(2000).
 */
export function mockGoogleDriveFilesList(
  respond: (request: Request) => GoogleDriveFilesListResponse,
): GoogleDriveFilesListRecorder {
  const recorded: GoogleDriveFilesListRecorder = {
    authorizationHeaders: [],
    queries: [],
  };

  server.use(
    http.get(GOOGLE_DRIVE_FILES_URL, ({ request }) => {
      recorded.authorizationHeaders.push(request.headers.get("authorization"));
      recorded.queries.push(new URL(request.url).searchParams.get("q") ?? "");
      const response = respond(request);
      if (response.status !== 200) {
        return new HttpResponse(null, { status: response.status });
      }
      return HttpResponse.json({ files: [...response.files] });
    }),
  );

  return recorded;
}

interface GoogleDriveArtifactUploadRecorder {
  readonly bodies: Uint8Array[];
  readonly authorizationHeaders: (string | null)[];
  readonly contentLengthHeaders: (string | null)[];
  readonly contentTypeHeaders: (string | null)[];
  readonly folderAuthorizationHeaders: (string | null)[];
  readonly folderQueries: string[];
}

/**
 * Google Drive folder and multipart-upload provider boundary. Folder lookups
 * resolve an existing root and thread folder so the recorder stays focused on
 * the file upload request.
 */
export function mockGoogleDriveArtifactUpload(
  file: GoogleDriveFileFixture,
): GoogleDriveArtifactUploadRecorder {
  const recorded: GoogleDriveArtifactUploadRecorder = {
    bodies: [],
    authorizationHeaders: [],
    contentLengthHeaders: [],
    contentTypeHeaders: [],
    folderAuthorizationHeaders: [],
    folderQueries: [],
  };

  server.use(
    http.get(GOOGLE_DRIVE_FILES_URL, ({ request }) => {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      recorded.folderAuthorizationHeaders.push(
        request.headers.get("authorization"),
      );
      recorded.folderQueries.push(query);
      const rootFolder = query.includes("'root' in parents");
      return HttpResponse.json({
        files: [
          {
            id: rootFolder
              ? "drive-artifact-root-folder"
              : "drive-artifact-thread-folder",
            name: rootFolder ? "vm0-artifact" : "thread-artifacts",
          },
        ],
      });
    }),
    http.post(GOOGLE_DRIVE_UPLOAD_URL, async ({ request }) => {
      recorded.authorizationHeaders.push(request.headers.get("authorization"));
      recorded.contentLengthHeaders.push(request.headers.get("content-length"));
      recorded.contentTypeHeaders.push(request.headers.get("content-type"));
      recorded.bodies.push(new Uint8Array(await request.arrayBuffer()));
      return HttpResponse.json(file);
    }),
  );

  return recorded;
}

function newGithubAppPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

interface GithubAppInstallProviderArgs {
  readonly installationId: string;
  readonly targetId: string;
  readonly targetType?: string;
  readonly targetLogin?: string;
}

/**
 * GitHub App installation provider boundary: env credentials (real RSA key,
 * the routes sign app JWTs with it) plus the remote installations list,
 * installation-info, and installation access-token endpoints.
 */
export function mockGithubAppInstallProvider(
  args: GithubAppInstallProviderArgs,
): void {
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", "123456");
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newGithubAppPrivateKeyBase64());
  mockEnv("APP_URL", "https://app.okou.test");

  server.use(
    http.get(GITHUB_APP_INSTALLATIONS_URL, () => {
      return HttpResponse.json([]);
    }),
    http.get(
      `${GITHUB_APP_INSTALLATIONS_URL}/:installationId`,
      ({ params }) => {
        if (String(params.installationId) !== args.installationId) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json({
          id: Number(args.installationId),
          app_id: 123_456,
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(args.targetId),
            login: args.targetLogin ?? "bdd-github-org",
            type: args.targetType ?? "Organization",
          },
        });
      },
    ),
    http.post(
      `${GITHUB_APP_INSTALLATIONS_URL}/:installationId/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_bdd_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

/**
 * Drives the connector OAuth callback route with a raw absolute-URL request
 * so origin-dependent behavior (canonical API-host redirects, trusted
 * web-origin headers) stays visible to the test.
 */
export async function requestOauthCallbackRaw(
  context: TestContext,
  args: {
    readonly origin: string;
    readonly connectorSlug: string;
    readonly query: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<Response> {
  const url = new URL(
    `/api/connectors/${args.connectorSlug}/callback`,
    args.origin,
  );
  for (const [name, value] of Object.entries(args.query)) {
    url.searchParams.set(name, value);
  }
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  return await app.request(url.toString(), { headers: args.headers });
}

interface TestOAuthDeviceConnectorProviderOptions {
  readonly deviceCode?: string;
  readonly interval?: number;
  readonly expiresIn?: number;
  readonly tokenScope?: string | null;
  readonly tokenBehavior?: "ok" | "emptyJson";
}

interface TestOAuthDeviceConnectorProviderRecorder {
  readonly deviceCodeBodies: URLSearchParams[];
  readonly tokenBodies: URLSearchParams[];
}

function testOAuthDeviceTokenErrorResponse(
  deviceCode: string | null,
): Response | null {
  if (deviceCode === "pending") {
    return HttpResponse.json(
      { error: "authorization_pending" },
      { status: 400 },
    );
  }
  if (deviceCode === "slow-down") {
    return HttpResponse.json({ error: "slow_down" }, { status: 400 });
  }
  if (deviceCode === "denied") {
    return HttpResponse.json(
      {
        error: "access_denied",
        error_description: "User denied the device authorization request",
      },
      { status: 400 },
    );
  }
  if (deviceCode === "expired") {
    return HttpResponse.json(
      {
        error: "expired_token",
        error_description: "Device authorization expired",
      },
      { status: 400 },
    );
  }
  if (deviceCode === "error") {
    return HttpResponse.json(
      {
        error: "invalid_request",
        error_description: "Synthetic device authorization error",
      },
      { status: 400 },
    );
  }
  if (!deviceCode?.startsWith("test-device:")) {
    return HttpResponse.json(
      {
        error: "invalid_grant",
        error_description: "Unknown device authorization code",
      },
      { status: 400 },
    );
  }
  return null;
}

export function mockTestOAuthDeviceConnectorProvider(
  options: TestOAuthDeviceConnectorProviderOptions = {},
): TestOAuthDeviceConnectorProviderRecorder {
  const recorded: TestOAuthDeviceConnectorProviderRecorder = {
    deviceCodeBodies: [],
    tokenBodies: [],
  };

  server.use(
    http.post(TEST_OAUTH_DEVICE_CODE_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      recorded.deviceCodeBodies.push(body);
      const clientId = body.get("client_id") ?? "missing-client";
      const scope = body.get("scope") ?? "";
      const mode = body.get("mode");
      const modeSuffix = mode ? `:${mode}` : "";
      const deviceCode =
        options.deviceCode ?? `test-device:${clientId}:${scope}${modeSuffix}`;

      return HttpResponse.json({
        device_code: deviceCode,
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: options.expiresIn ?? 600,
        interval: options.interval ?? 0,
      });
    }),
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      recorded.tokenBodies.push(body);

      if (options.tokenBehavior === "emptyJson") {
        return HttpResponse.json({});
      }
      if (body.get("grant_type") !== DEVICE_CODE_GRANT_TYPE) {
        return HttpResponse.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }

      const deviceCode = body.get("device_code");
      const errorResponse = testOAuthDeviceTokenErrorResponse(deviceCode);
      if (errorResponse) {
        return errorResponse;
      }

      return HttpResponse.json({
        access_token: `test-device-access:${deviceCode}`,
        token_type: "Bearer",
        expires_in: 3600,
        ...(options.tokenScope === null
          ? {}
          : { scope: options.tokenScope ?? "read" }),
      });
    }),
  );

  return recorded;
}

interface DeferredTestOAuthTokenEndpoint {
  readonly started: Promise<void>;
  release(): void;
  calls(): number;
}

/**
 * Shadows the test-oauth device token endpoint with a handler whose first
 * call blocks until {@link DeferredTestOAuthTokenEndpoint.release} is called
 * and then completes; later calls return authorization_pending immediately.
 * The owner signal cancels both synchronization promises before detached-work
 * teardown. Callers must still release explicitly and await all in-flight
 * polls before the test ends; the finish hook also releases a pending gate.
 */
export function mockDeferredTestOAuthTokenEndpoint(
  signal: AbortSignal,
): DeferredTestOAuthTokenEndpoint {
  let callCount = 0;
  const gate = createDeferredPromise<void>(signal);
  const releaseGate = (): void => {
    if (!gate.settled()) {
      gate.resolve(undefined);
    }
  };
  onTestFinished(() => {
    releaseGate();
  });
  const started = createDeferredPromise<void>(signal);
  const markStarted = (): void => {
    if (!started.settled()) {
      started.resolve(undefined);
    }
  };

  server.use(
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      callCount += 1;
      if (callCount > 1) {
        return HttpResponse.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      }
      markStarted();
      await gate.promise;
      return HttpResponse.json({
        access_token: `test-device-access:${body.get("device_code") ?? ""}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    }),
  );

  return {
    started: started.promise,
    release() {
      releaseGate();
    },
    calls() {
      return callCount;
    },
  };
}

interface Base44OAuthProviderRecorder {
  readonly deviceCodeBodies: unknown[];
  readonly tokenBodies: URLSearchParams[];
  readonly userinfoAuthorizations: (string | null)[];
}

export function mockBase44OAuthProvider(): Base44OAuthProviderRecorder {
  const recorded: Base44OAuthProviderRecorder = {
    deviceCodeBodies: [],
    tokenBodies: [],
    userinfoAuthorizations: [],
  };

  server.use(
    http.post(BASE44_DEVICE_CODE_URL, async ({ request }) => {
      recorded.deviceCodeBodies.push(await request.json());
      return HttpResponse.json({
        device_code: "base44-device-code",
        user_code: "BASE-44",
        verification_uri: "https://app.base44.com/device",
        verification_uri_complete:
          "https://app.base44.com/device?user_code=BASE-44",
        expires_in: 600,
        interval: 0,
      });
    }),
    http.post(BASE44_TOKEN_URL, async ({ request }) => {
      recorded.tokenBodies.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: "base44-access-token",
        refresh_token: "base44-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.get(BASE44_USERINFO_URL, ({ request }) => {
      recorded.userinfoAuthorizations.push(
        request.headers.get("authorization"),
      );
      return HttpResponse.json({
        sub: "base44-user-id",
        name: "Base44 User",
        email: "base44@example.com",
      });
    }),
  );

  return recorded;
}

function slockJwtAccessToken(subject: string): string {
  const issuedAt = Math.floor(now() / 1000);
  const encode = (value: unknown): string => {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  };
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: subject,
      type: "access",
      iat: issuedAt,
      exp: issuedAt + 900,
    }),
    "signature",
  ].join(".");
}

interface SlockOAuthProviderMock {
  readonly accessToken: string;
}

export function mockSlockOAuthProvider(
  options: { readonly deviceCode?: string } = {},
): SlockOAuthProviderMock {
  const accessToken = slockJwtAccessToken("slock-user-id");

  server.use(
    http.post(SLOCK_DEVICE_CODE_URL, () => {
      return HttpResponse.json({
        deviceCode: options.deviceCode ?? "slock-device-code",
        userCode: "SLOCK-1",
        verificationUri: "https://api.slock.ai/device",
        expiresIn: 600,
        interval: 0,
      });
    }),
    http.post(SLOCK_TOKEN_URL, async ({ request }) => {
      const { deviceCode } = z
        .object({ deviceCode: z.string() })
        .parse(await request.json());
      if (deviceCode === "userinfo-error") {
        return HttpResponse.json({
          accessToken: "slock-access-userinfo-error",
          refreshToken: "slock-refresh-token",
          userId: "slock-user-id",
        });
      }
      if (deviceCode !== "slock-device-code") {
        return HttpResponse.json({ code: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({
        accessToken,
        refreshToken: "slock-refresh-token",
        userId: "slock-user-id",
      });
    }),
    http.get(SLOCK_SERVERS_URL, () => {
      return HttpResponse.json([{ id: "slock-server-id", name: "Primary" }]);
    }),
    http.get(SLOCK_USERINFO_URL, ({ request }) => {
      if (
        request.headers.get("authorization") ===
        "Bearer slock-access-userinfo-error"
      ) {
        return HttpResponse.json(
          { code: "userinfo_lookup_failed" },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        id: "slock-user-id",
        name: "Slock User",
        email: "slock@example.com",
      });
    }),
  );

  return { accessToken };
}

interface StripeCliDashboardAuthMock {
  readonly startBodies: URLSearchParams[];
  readonly pollCount: () => number;
}

export function mockStripeCliDashboardAuth(): StripeCliDashboardAuthMock {
  const startBodies: URLSearchParams[] = [];
  let pollCount = 0;

  server.use(
    http.post(STRIPE_CLI_AUTH_URL, async ({ request }) => {
      startBodies.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        browser_url: STRIPE_CLI_BROWSER_URL,
        poll_url: STRIPE_CLI_POLL_URL,
        verification_code: "STRIPE-CLI",
      });
    }),
    http.get(STRIPE_CLI_POLL_URL, () => {
      pollCount += 1;
      return HttpResponse.json({
        redeemed: true,
        account_id: "acct_bdd",
        account_display_name: "BDD Stripe",
        livemode_key_secret: "rk_live_api456",
        livemode_key_publishable: "pk_live_api456",
        testmode_key_secret: "rk_test_api123",
        testmode_key_publishable: "pk_test_api123",
      });
    }),
  );

  return {
    startBodies,
    pollCount: () => {
      return pollCount;
    },
  };
}

const AWS_SIGNIN_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";

const awsTokenRequestSchema = z.object({
  clientId: z.literal("arn:aws:signin:::devtools/cross-device"),
  grantType: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().optional(),
  codeVerifier: z.string().optional(),
  redirectUri: z.string().optional(),
  refreshToken: z.string().optional(),
});

type AwsTokenRequest = z.infer<typeof awsTokenRequestSchema>;

interface AwsExternalCodeProviderRecorder {
  readonly tokenRequests: AwsTokenRequest[];
}

interface AwsDeferredTokenExchange {
  readonly tokenRequestStarted: Promise<void>;
  readonly tokenRequests: AwsTokenRequest[];
  releaseTokenResponse(): void;
}

/**
 * Builds the verification code a user would paste after authorizing in the
 * AWS console: base64("state=<state from the authorization URL>&code=...").
 */
export function awsVerificationCode(
  authorizationUrl: string,
  code = "AWS-CODE",
): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected AWS authorization URL to include state");
  }
  return Buffer.from(new URLSearchParams({ state, code }).toString()).toString(
    "base64",
  );
}

function awsTokenEndpointResponseBody(
  credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
  } = {
    accessKeyId: "aws-external-code-credential-id",
    secretAccessKey: "aws-secret-access-key",
    sessionToken: "aws-session-token",
  },
) {
  return {
    accessToken: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    expiresIn: 900,
    refreshToken: "aws-login-refresh-token",
    tokenType: "aws_sigv4",
    idToken: "aws-id-token",
  };
}

function awsStsCallerIdentityXml(): string {
  return [
    "<GetCallerIdentityResponse>",
    "<GetCallerIdentityResult>",
    "<UserId>AIDAEXTERNALUSER</UserId>",
    "<Account>123456789012</Account>",
    "<Arn>arn:aws:iam::123456789012:user/external-code</Arn>",
    "</GetCallerIdentityResult>",
    "</GetCallerIdentityResponse>",
  ].join("");
}

/**
 * AWS Sign-In external-code provider boundary. The token endpoint enforces
 * the cross-device exchange contract (JSON body shape plus a DPoP proof
 * header) and rejects the synthetic verification code "AWS-BAD" with
 * invalid_grant; the STS endpoint answers GetCallerIdentity, or fails with
 * HTTP 500 when stsFailure is set.
 */
export function mockAwsExternalCodeProvider(
  options: {
    readonly stsFailure?: boolean;
    readonly credentialsByRequest?: readonly {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken: string;
    }[];
  } = {},
): AwsExternalCodeProviderRecorder {
  const recorded: AwsExternalCodeProviderRecorder = { tokenRequests: [] };

  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      if (!request.headers.get("dpop")) {
        return HttpResponse.json(
          {
            error: "invalid_request",
            error_description: "Missing DPoP proof",
          },
          { status: 400 },
        );
      }
      recorded.tokenRequests.push(body);
      if (body.code === "AWS-BAD") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Rejected authorization code",
          },
          { status: 400 },
        );
      }
      const credentials =
        options.credentialsByRequest?.[recorded.tokenRequests.length - 1];
      if (options.credentialsByRequest && !credentials) {
        throw new Error("Missing AWS credentials for token request");
      }
      return HttpResponse.json({
        tokenOutput: awsTokenEndpointResponseBody(credentials),
      });
    }),
    http.get(AWS_STS_URL, () => {
      if (options.stsFailure) {
        return HttpResponse.text("AWS STS unavailable", { status: 500 });
      }
      return HttpResponse.xml(awsStsCallerIdentityXml());
    }),
  );

  return recorded;
}

/**
 * Shadows the AWS token endpoint with a handler that blocks every exchange
 * until {@link AwsDeferredTokenExchange.releaseTokenResponse} is called; the
 * STS identity endpoint stays live. The gate auto-releases when the test
 * finishes (even on assertion failure) so a hung handler can never leak past
 * the test; callers must still release explicitly and await all in-flight
 * completions before the test ends.
 */
export function mockAwsDeferredTokenExchange(): AwsDeferredTokenExchange {
  const tokenRequests: AwsTokenRequest[] = [];
  const gate = createDeferredPromise<void>(AbortSignal.any([]));
  const releaseGate = (): void => {
    if (!gate.settled()) {
      gate.resolve(undefined);
    }
  };
  onTestFinished(() => {
    releaseGate();
  });
  const started = createDeferredPromise<void>(AbortSignal.any([]));
  const markStarted = (): void => {
    if (!started.settled()) {
      started.resolve(undefined);
    }
  };

  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      tokenRequests.push(body);
      markStarted();
      await gate.promise;
      return HttpResponse.json({ tokenOutput: awsTokenEndpointResponseBody() });
    }),
    http.get(AWS_STS_URL, () => {
      return HttpResponse.xml(awsStsCallerIdentityXml());
    }),
  );

  return {
    tokenRequestStarted: started.promise,
    tokenRequests,
    releaseTokenResponse() {
      releaseGate();
    },
  };
}

export function createConnectorBddApi(context: TestContext) {
  const mocks = createRouteMocks(context);

  function authenticate(nextActor: ApiTestUser | null): AuthHeaders {
    if (!nextActor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    mocks.clerk.session(nextActor.userId, nextActor.orgId, nextActor.orgRole);
    return authHeaders(nextActor);
  }

  const api = {
    async requestListConnectors(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorsMainContract,
      );
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listConnectors(actor: ApiTestUser): Promise<ConnectorListResponse> {
      const response = await api.requestListConnectors(actor, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestSearchConnectors(
      actor: ApiTestUser | null,
      keyword: string | undefined,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorsSearchContract,
      );
      return await accept(
        client.search({ query: { keyword }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async searchConnectors(
      actor: ApiTestUser,
      keyword?: string,
    ): Promise<ConnectorSearchResponse> {
      const response = await api.requestSearchConnectors(actor, keyword, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestReadConnectorBySlug(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      );
      return await accept(
        client.get({
          params: { connectorSlug },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async readConnectorBySlug(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
    ): Promise<ConnectorResponse> {
      const response = await api.requestReadConnectorBySlug(
        actor,
        connectorSlug,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async deleteDefaultBuiltinConnectorAccount(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
    ): Promise<void> {
      const client = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      const response = await accept(
        client.connections({
          headers: authenticate(actor),
          query: { kind: "builtin", connectorSlug, limit: 100 },
        }),
        [200, 404],
      );
      if (response.status === 404) {
        return;
      }
      const account = response.body.connections.find((candidate) => {
        return candidate.isDefault;
      });
      if (!account) {
        return;
      }
      await api.deleteBuiltinConnectorAccount(actor, connectorSlug, account.id);
    },

    async listBuiltinConnectorAccounts(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
    ): Promise<readonly ConnectorAccountConnection[]> {
      const client = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      const response = await accept(
        client.connections({
          headers: authenticate(actor),
          query: { kind: "builtin", connectorSlug, limit: 100 },
        }),
        [200],
      );
      return response.body.connections;
    },

    async setDefaultBuiltinConnectorAccount(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      connectionId: string,
    ): Promise<ConnectorAccountConnection> {
      const client = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      const response = await accept(
        client.setDefault({
          headers: authenticate(actor),
          params: { connectionId },
          body: { target: { kind: "builtin", connectorSlug } },
        }),
        [200],
      );
      return response.body;
    },

    async deleteBuiltinConnectorAccount(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      connectionId: string,
    ): Promise<void> {
      const client = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { connectionId },
          body: { target: { kind: "builtin", connectorSlug } },
        }),
        [200],
      );
    },

    async listCustomConnectorAccounts(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<readonly ConnectorAccountConnection[]> {
      const client = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      const response = await accept(
        client.connections({
          headers: authenticate(actor),
          query: {
            kind: "custom",
            customConnectorId: connectorId,
            limit: 100,
          },
        }),
        [200],
      );
      return response.body.connections;
    },

    async requestScopeDiff(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorScopeDiffContract,
      );
      return await accept(
        client.getScopeDiff({
          params: { connectorSlug },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async readScopeDiff(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
    ): Promise<ScopeDiffResponse> {
      const response = await api.requestScopeDiff(actor, connectorSlug, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestManualGrant(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
      options: {
        readonly statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[];
        readonly agentId?: string;
        readonly authorizeAgent?: true;
        readonly account?: ConnectorAccountMutationIntent;
      },
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorManualGrantContract,
      );
      return await accept(
        client.connect({
          params: { connectorSlug },
          headers: authenticate(actor),
          body: {
            authMethod,
            values,
            ...(options.agentId ? { agentId: options.agentId } : {}),
            ...(options.authorizeAgent ? { authorizeAgent: true } : {}),
            account: options.account ?? { intent: "add" },
          },
        }),
        options.statuses,
      );
    },

    async connectManualGrant(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
      ...options: readonly [
        agentId?: string,
        account?: ConnectorAccountMutationIntent,
      ]
    ): Promise<ConnectorResponse> {
      const [agentId, account = { intent: "add" }] = options;
      const response = await api.requestManualGrant(
        actor,
        connectorSlug,
        authMethod,
        values,
        { statuses: [200], agentId, authorizeAgent: true, account },
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestOauthStart(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      options: {
        readonly statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[];
        readonly agentId?: string;
        readonly authorizeAgent?: true;
        readonly callbackTarget?: "app";
        readonly account?: ConnectorAccountMutationIntent;
      },
    ) {
      const client = setupApp({ context, routes: connectorsRoutes })(
        connectorOauthStartContract,
      );
      return await accept(
        client.start({
          params: { connectorSlug },
          headers: authenticate(actor),
          body: {
            authMethod,
            ...(options.agentId ? { agentId: options.agentId } : {}),
            ...(options.authorizeAgent ? { authorizeAgent: true } : {}),
            ...(options.callbackTarget
              ? { callbackTarget: options.callbackTarget }
              : {}),
            account: options.account ?? { intent: "add" },
          },
        }),
        options.statuses,
      );
    },

    async startOauth(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      agentId?: string,
      account?: ConnectorAccountMutationIntent,
    ): Promise<ConnectorOauthStartResponse> {
      const response = await api.requestOauthStart(
        actor,
        connectorSlug,
        authMethod,
        {
          statuses: [200],
          agentId,
          authorizeAgent: true,
          account,
        },
      );
      expectStatus(response, 200);
      return response.body;
    },

    async completeOauthCallback(
      connectorSlug: string,
      query: CallbackQuery,
      options: { readonly baseUrl?: string } = {},
    ) {
      const client = setupApp({
        baseUrl: options.baseUrl,
        context,
        routes: connectorsSlugCallbackRoutes,
      })(connectorsSlugCallbackContract);
      return await accept(
        client.callback({
          params: { connectorSlug },
          query,
          headers: {},
        }),
        [307],
      );
    },

    async completeOauthCallbackResult(
      connectorSlug: string,
      query: CallbackQuery,
    ) {
      const client = setupApp({
        context,
        routes: connectorsSlugCallbackRoutes,
      })(connectorsSlugCallbackContract);
      const response = await accept(
        client.callback({
          params: { connectorSlug },
          query: { ...query, responseMode: "json" },
          headers: {},
        }),
        [200],
      );
      expectStatus(response, 200);
      return response;
    },

    /**
     * Installs the GitHub App for the actor's org through the public install
     * redirect and setup callback routes (no DB seeding): extracts the signed
     * state from the install redirect and replays it to the setup callback.
     */
    async installGithubAppViaApi(
      actor: ApiTestUser,
      composeId: string,
      installationId: string,
    ): Promise<void> {
      if (!actor.orgId) {
        throw new Error("GitHub App install requires an actor with an org");
      }
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              organization: { id: actor.orgId },
              role: actor.orgRole ?? "org:admin",
              createdAt: 1,
            },
          ],
        },
      );

      const client = setupApp({ context, routes: githubOauthRoutes })(
        githubOauthContract,
      );
      const install = await accept(
        client.install({
          query: {
            userId: actor.userId,
            orgId: actor.orgId,
            composeId,
          },
        }),
        [307],
      );
      const installLocation = install.headers.get("location");
      if (!installLocation) {
        throw new Error("Expected a GitHub install redirect location");
      }
      const installUrl = new URL(installLocation);
      if (!installUrl.pathname.endsWith("/installations/new")) {
        throw new Error(
          `Unexpected GitHub install redirect: ${installLocation}`,
        );
      }
      const state = installUrl.searchParams.get("state");
      if (!state) {
        throw new Error("Expected the GitHub install redirect to carry state");
      }

      const providerCallbackUri = installUrl.searchParams.get("redirect_uri");
      if (!providerCallbackUri) {
        throw new Error(
          "Expected the GitHub install redirect to carry a callback URI",
        );
      }
      const callbackQuery = {
        installation_id: installationId,
        setup_action: "install" as const,
        state,
      };
      const requestSetupCallback = async (baseUrl: string) => {
        const callbackClient = setupApp({
          baseUrl,
          context,
          routes: githubOauthRoutes,
        })(githubOauthContract);
        return await accept(
          callbackClient.setupCallback({ query: callbackQuery }),
          [307],
        );
      };
      let callback = await requestSetupCallback(
        new URL(providerCallbackUri).origin,
      );
      let callbackLocation = callback.headers.get("location");
      if (!callbackLocation) {
        throw new Error("Expected a GitHub setup callback redirect location");
      }
      const firstCallbackLocation = new URL(callbackLocation);
      if (firstCallbackLocation.pathname === "/api/github/app/setup/callback") {
        callback = await requestSetupCallback(firstCallbackLocation.origin);
        callbackLocation = callback.headers.get("location");
        if (!callbackLocation) {
          throw new Error(
            "Expected the branded GitHub setup callback to redirect",
          );
        }
      }
      const callbackError = new URL(callbackLocation).searchParams.get("error");
      if (callbackError) {
        throw new Error(`GitHub setup callback failed: ${callbackError}`);
      }
    },

    async readGithubIntegration(
      actor: ApiTestUser,
    ): Promise<GithubInstallationResponse> {
      const client = setupApp({ context, routes: integrationsGithubRoutes })(
        integrationsGithubContract,
      );
      const response = await accept(
        client.getInstallation({ headers: authenticate(actor) }),
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeviceAuthStart(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      ...request: [
        options: Readonly<Record<string, string>> | undefined,
        statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
        account?: ConnectorAccountMutationIntent,
      ]
    ) {
      const [options, statuses, account = { intent: "add" }] = request;
      const client = setupApp({
        context,
        routes: connectorsOauthDeviceAuthRoutes,
      })(connectorOauthDeviceAuthSessionContract);
      return await accept(
        client.create({
          params: { connectorSlug },
          headers: authenticate(actor),
          body: { authMethod, options, account },
        }),
        statuses,
      );
    },

    async startDeviceAuth(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      options?: Readonly<Record<string, string>>,
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ): Promise<ConnectorOauthDeviceAuthSessionStartResponse> {
      const response = await api.requestDeviceAuthStart(
        actor,
        connectorSlug,
        authMethod,
        options,
        [200],
        account,
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeviceAuthPoll(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      sessionId: string,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: connectorsOauthDeviceAuthRoutes,
      })(connectorOauthDeviceAuthSessionContract);
      return await accept(
        client.poll({
          params: { connectorSlug, sessionId },
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async pollDeviceAuth(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      sessionId: string,
      sessionToken: string,
    ): Promise<ConnectorOauthDeviceAuthSessionPollResponse> {
      const response = await api.requestDeviceAuthPoll(
        actor,
        connectorSlug,
        sessionId,
        sessionToken,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestExternalCodeStart(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ) {
      const client = setupApp({
        context,
        routes: connectorsExternalCodeRoutes,
      })(connectorExternalCodeSessionContract);
      return await accept(
        client.create({
          params: { connectorSlug },
          headers: authenticate(actor),
          body: { authMethod, account },
        }),
        statuses,
      );
    },

    async requestExternalCodeComplete(
      actor: ApiTestUser | null,
      connectorSlug: ConnectorSlug,
      args: {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly code: string;
      },
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: connectorsExternalCodeRoutes,
      })(connectorExternalCodeSessionContract);
      return await accept(
        client.complete({
          params: { connectorSlug, sessionId: args.sessionId },
          headers: authenticate(actor),
          body: { sessionToken: args.sessionToken, code: args.code },
        }),
        statuses,
      );
    },

    async startExternalCode(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      authMethod: ConnectorAuthMethodId,
      account?: ConnectorAccountMutationIntent,
    ): Promise<ConnectorExternalCodeSessionStartResponse> {
      const response = await api.requestExternalCodeStart(
        actor,
        connectorSlug,
        authMethod,
        [200],
        account,
      );
      expectStatus(response, 200);
      return response.body;
    },

    async completeExternalCode(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
      args: {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly code: string;
      },
    ): Promise<ConnectorExternalCodeSessionCompleteResponse> {
      const response = await api.requestExternalCodeComplete(
        actor,
        connectorSlug,
        args,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ): Promise<Readonly<Record<string, boolean>>> {
      const client = setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      );
      const response = await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
      return response.body.switches;
    },

    async deleteFeatureSwitches(actor: ApiTestUser): Promise<void> {
      const client = setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      );
      await accept(client.delete({ headers: authenticate(actor) }), [200]);
    },

    async requestCreateCustomConnector(
      actor: ApiTestUser | null,
      body: CreateCustomConnectorBody,
      statuses: readonly (201 | 400 | 401 | 403 | 500)[],
      signal?: AbortSignal,
    ) {
      const client = setupApp({
        context,
        routes: customConnectorsRoutes,
        signal,
      })(customConnectorsContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestCreateCustomConnectorRaw(
      actor: ApiTestUser | null,
      body: unknown,
    ): Promise<Response> {
      const app = createApp({
        signal: context.signal,
        routes: customConnectorsRoutes,
      });
      return await app.request("/api/custom-connectors", {
        method: "POST",
        headers: {
          ...authenticate(actor),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },

    async createCustomConnector(
      actor: ApiTestUser,
      body: CreateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestCreateCustomConnector(
        actor,
        body,
        [201],
      );
      expectStatus(response, 201);
      return response.body;
    },

    async requestListCustomConnectors(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 500)[],
    ) {
      const client = setupApp({ context, routes: customConnectorsRoutes })(
        customConnectorsContract,
      );
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listCustomConnectors(
      actor: ApiTestUser,
    ): Promise<readonly CustomConnectorResponse[]> {
      const response = await api.requestListCustomConnectors(actor, [200]);
      expectStatus(response, 200);
      return response.body.connectors;
    },

    async readCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<CustomConnectorResponse> {
      const client = setupApp({
        context,
        routes: customConnectorByIdTestRoutes,
      })(customConnectorByIdContract);
      const response = await accept(
        client.get({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestCustomConnectorPermissions(
      actor: ApiTestUser | null,
      connectorId: string,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: customConnectorByIdTestRoutes,
      })(customConnectorByIdContract);
      return await accept(
        client.permissions({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async readCustomConnectorPermissions(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<CustomConnectorPermissionBundleResponse> {
      const response = await api.requestCustomConnectorPermissions(
        actor,
        connectorId,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestUpdateCustomConnector(
      actor: ApiTestUser | null,
      connectorId: string,
      body: UpdateCustomConnectorBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: customConnectorByIdTestRoutes,
      })(customConnectorByIdContract);
      return await accept(
        client.update({
          params: { id: connectorId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async updateCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      body: UpdateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestUpdateCustomConnector(
        actor,
        connectorId,
        body,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeleteCustomConnector(
      actor: ApiTestUser | null,
      connectorId: string,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: customConnectorByIdTestRoutes,
      })(customConnectorByIdContract);
      return await accept(
        client.delete({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async deleteCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[] = [204],
    ): Promise<void> {
      await api.requestDeleteCustomConnector(actor, connectorId, statuses);
    },

    async requestSaveCustomConnectorProposal(
      actor: ApiTestUser | null,
      body: SaveCustomConnectorProposalBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: customConnectorProposalRoutes,
      })(customConnectorProposalContract);
      return await accept(
        client.save({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async saveCustomConnectorProposal(
      actor: ApiTestUser,
      body: SaveCustomConnectorProposalBody,
    ): Promise<SaveCustomConnectorProposalResponse> {
      const response = await api.requestSaveCustomConnectorProposal(
        actor,
        body,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestSetCustomConnectorSecret(
      actor: ApiTestUser | null,
      connectorId: string,
      value: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ) {
      const client = setupApp({
        context,
        routes: customConnectorsValuesSetRoutes,
      })(customConnectorValuesContract);
      return await accept(
        client.set({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: {
            values: [{ key: "secret", kind: "secret", value }],
            account,
          },
        }),
        statuses,
      );
    },

    async setCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      value: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[] = [200],
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ): Promise<void> {
      await api.requestSetCustomConnectorSecret(
        actor,
        connectorId,
        value,
        statuses,
        account,
      );
    },

    async requestSetCustomConnectorValues(
      actor: ApiTestUser | null,
      connectorId: string,
      values: readonly CustomConnectorValueInput[],
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ) {
      const client = setupApp({
        context,
        routes: customConnectorsValuesSetRoutes,
      })(customConnectorValuesContract);
      return await accept(
        client.set({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: { values: [...values], account },
        }),
        statuses,
      );
    },

    async setCustomConnectorValues(
      actor: ApiTestUser,
      connectorId: string,
      values: readonly CustomConnectorValueInput[],
      account?: ConnectorAccountMutationIntent,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestSetCustomConnectorValues(
        actor,
        connectorId,
        values,
        [200],
        account,
      );
      expectStatus(response, 200);
      return response.body;
    },

    async deleteCustomConnectorAccount(
      actor: ApiTestUser,
      connectorId: string,
      connectionId: string,
    ): Promise<void> {
      const client = setupApp({
        context,
        routes: connectorAccountRoutes,
      })(connectorAccountsContract);
      await accept(
        client.delete({
          params: { connectionId },
          headers: authenticate(actor),
          body: {
            target: { kind: "custom", customConnectorId: connectorId },
          },
        }),
        [200],
      );
    },

    async deleteDefaultCustomConnectorAccount(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<void> {
      const accounts = await api.listCustomConnectorAccounts(
        actor,
        connectorId,
      );
      const account = accounts.find((candidate) => {
        return candidate.isDefault;
      });
      if (!account) {
        return;
      }
      await api.deleteCustomConnectorAccount(actor, connectorId, account.id);
    },

    async requestStartCustomConnectorOAuth2(
      actor: ApiTestUser | null,
      connectorId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500 | 502)[],
      agentId?: string,
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ) {
      const client = setupApp({
        context,
        routes: customConnectorOAuth2Routes,
      })(customConnectorOAuth2Contract);
      return await accept(
        client.start({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: { ...(agentId ? { agentId } : {}), account },
        }),
        statuses,
      );
    },

    async startCustomConnectorOAuth2(
      actor: ApiTestUser,
      connectorId: string,
      agentId?: string,
      account?: ConnectorAccountMutationIntent,
    ): Promise<string> {
      const response = await api.requestStartCustomConnectorOAuth2(
        actor,
        connectorId,
        [200],
        agentId,
        account,
      );
      expectStatus(response, 200);
      if (response.body.result !== "authorization") {
        throw new Error("Expected Custom Connector OAuth authorization");
      }
      return response.body.authorizationUrl;
    },

    async startCustomConnectorOAuth2AtBaseUrl(
      actor: ApiTestUser,
      connectorId: string,
      baseUrl: string,
      account: ConnectorAccountMutationIntent = { intent: "add" },
    ): Promise<string> {
      const client = setupApp({
        baseUrl,
        context,
        routes: customConnectorOAuth2Routes,
      })(customConnectorOAuth2Contract);
      const response = await accept(
        client.start({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: { account },
        }),
        [200],
      );
      if (response.body.result !== "authorization") {
        throw new Error("Expected Custom Connector OAuth authorization");
      }
      return response.body.authorizationUrl;
    },

    async completeCustomConnectorOAuth2Callback(
      query: CallbackQuery,
      options: RequestBaseUrlOptions = {},
    ) {
      const client = setupApp({
        ...options,
        context,
        routes: customConnectorOAuth2Routes,
      })(customConnectorOAuth2Contract);
      return await accept(client.callback({ query }), [307]);
    },

    async completeCustomConnectorOAuth2CallbackResult(
      query: CallbackQuery,
      options: RequestBaseUrlOptions = {},
    ) {
      const client = setupApp({
        ...options,
        context,
        routes: customConnectorOAuth2Routes,
      })(customConnectorOAuth2Contract);
      const response = await accept(
        client.callback({ query: { ...query, responseMode: "json" } }),
        [200],
      );
      expectStatus(response, 200);
      return response;
    },

    async requestAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context, routes: agentsRoutes })(
        agentCustomConnectorsContract,
      );
      return await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async readAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly string[]> {
      const response = await api.requestAgentCustomConnectors(
        actor,
        agentId,
        [200],
      );
      expectStatus(response, 200);
      return response.body.grants.map((grant) => {
        return grant.customConnectorId;
      });
    },

    async readAgentCustomConnectorGrants(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly AgentCustomConnectorGrant[]> {
      const response = await api.requestAgentCustomConnectors(
        actor,
        agentId,
        [200],
      );
      expectStatus(response, 200);
      return response.body.grants;
    },

    async requestUpdateAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      connectorIds: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
      operation?: "replace" | "add" | "remove",
    ) {
      const client = setupApp({ context, routes: agentsRoutes })(
        agentCustomConnectorsContract,
      );
      const body =
        operation === undefined
          ? {
              grants: connectorIds.map((customConnectorId) => {
                return { customConnectorId, permissionNames: [] };
              }),
            }
          : {
              grants: connectorIds.map((customConnectorId) => {
                return { customConnectorId, permissionNames: [] };
              }),
              operation,
            };
      return await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async requestUpdateAgentCustomConnectorsRaw(
      actor: ApiTestUser | null,
      agentId: string,
      body: unknown,
    ): Promise<Response> {
      const app = createApp({
        signal: context.signal,
        routes: agentsRoutes,
      });
      return await app.request(`/api/agents/${agentId}/custom-connectors`, {
        method: "PUT",
        headers: {
          ...authenticate(actor),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },

    async updateAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
      connectorIds: readonly string[],
      operation?: "replace" | "add" | "remove",
    ): Promise<readonly string[]> {
      const response = await api.requestUpdateAgentCustomConnectors(
        actor,
        agentId,
        connectorIds,
        [200],
        operation,
      );
      expectStatus(response, 200);
      return response.body.grants.map((grant) => {
        return grant.customConnectorId;
      });
    },

    async requestUpdateAgentCustomConnectorGrants(
      actor: ApiTestUser | null,
      agentId: string,
      grants: readonly AgentCustomConnectorGrant[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
      operation?: "replace" | "add" | "remove",
    ) {
      const client = setupApp({ context, routes: agentsRoutes })(
        agentCustomConnectorsContract,
      );
      const body =
        operation === undefined
          ? { grants: [...grants] }
          : { grants: [...grants], operation };
      return await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },
  };

  return api;
}
