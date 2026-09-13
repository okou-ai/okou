/**
 * helper gap:
 * - Expired OAuth states, stale/hidden legacy connector rows, stale OAuth scope
 *   rows, sandbox/CLI token capability cases, and simultaneous callback races
 *   do not have a stable public API constructor/assertion path. They are
 *   intentionally not rebuilt with direct database fixtures here.
 * - Feature switch overrides are configured only through
 *   /api/feature-switches.
 */

import { randomInt, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  customConnectorsContract,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { extractFileFromTarGz } from "../../../lib/tar";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  installApiTestConnectorCatalog,
  replaceApiTestConnectorCatalogFilteredAuthMethods,
} from "../../../test-fixtures/connector-catalog";
import { generateOkouToken } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
  mockBase44OAuthProvider,
  mockCustomConnectorOAuth2Provider,
  mockDatadogConnectorOAuth,
  mockDeferredTestOAuthTokenEndpoint,
  mockGitHubConnectorOAuth,
  mockGithubAppInstallProvider,
  mockSlackConnectorOAuth,
  mockSlockOAuthProvider,
  mockStripeCliDashboardAuth,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
  requestOauthCallbackRaw,
} from "./helpers/api-bdd-connectors";
import { readUserSecrets } from "./helpers/user-config-state";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import {
  deleteCustomConnectorCredentialValues,
  readAutomaticOAuthBindingState,
  readConnectorCredentialStorageState,
  readCustomConnectorCredentialStorageParent,
  readCustomConnectorOAuthStorageState,
  seedAutomaticOAuthBindingState,
  seedCustomConnectorOAuthStateContext,
  setConnectorDefaultState,
  setBuiltinOAuthScopeFacts,
  setCustomConnectorCredentialStorageState,
} from "./helpers/connector-credential-storage-state";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { customConnectorsRoutes } from "../custom-connectors";
import { connectorCatalogRoutes } from "../connector-catalog";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const storagesApi = createStoragesBddApi(context);

async function installCatalogWithUnavailableMethods(args: {
  readonly capabilityIdentityEnvName: string;
  readonly filteredAuthMethods: Parameters<
    typeof replaceApiTestConnectorCatalogFilteredAuthMethods
  >[0];
}): Promise<void> {
  mockOptionalEnv(args.capabilityIdentityEnvName, undefined);
  await installApiTestConnectorCatalog();
  await replaceApiTestConnectorCatalogFilteredAuthMethods(
    args.filteredAuthMethods,
  );
}

function mockAuthoritativeOrganizationMembers(
  actors: readonly ApiTestUser[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: actors.map((actor) => {
        return { publicUserData: { userId: actor.userId } };
      }),
    },
  );
}

function clearConnectorInvalidationMocks(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function expectCustomConnectorInvalidations(userIds: readonly string[]): void {
  expect(
    context.mocks.ably.channelGet.mock.calls
      .map(([channelName]) => {
        return channelName;
      })
      .sort(),
  ).toStrictEqual(
    userIds
      .map((userId) => {
        return `user:${userId}`;
      })
      .sort(),
  );
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(userIds.length);
  for (const call of context.mocks.ably.publish.mock.calls) {
    expect(call).toStrictEqual(["customConnectorListChanged", null]);
  }
}

function uniqueSlug(prefix: string): string {
  return `_${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function uploadedSkillInstruction(command: unknown): string | null {
  const input = commandInput(command);
  if (
    !String(input.Key).endsWith("/archive.tar.gz") ||
    !Buffer.isBuffer(input.Body)
  ) {
    return null;
  }
  return extractFileFromTarGz(input.Body, "SKILL.md");
}

function customConnectorBody(slug: string) {
  return manualHttpCustomConnectorCreateBody({
    slug,
    displayName: "BDD Custom Connector",
    prefixTemplates: [`https://${slug.slice(1)}.example.test/v1/`],
  });
}

type McpCreateBody = Extract<
  CreateCustomConnectorBody,
  { readonly kind: "mcp" }
>;

function manualMcpConnectorBody(args: {
  readonly displayName: string;
  readonly endpoint: string;
}): McpCreateBody {
  return {
    kind: "mcp",
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API Token",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
  };
}

function connectorBySlug(
  connectors: readonly ConnectorResponse[],
  connectorSlug: ConnectorResponse["slug"],
): ConnectorResponse | undefined {
  return connectors.find((connector) => {
    return connector.slug === connectorSlug;
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

function requiredOrgId(user: ApiTestUser): string {
  if (!user.orgId) {
    throw new Error("Expected test user to have an organization");
  }
  return user.orgId;
}

function expectNoVisibleSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}

interface RedirectResponseLike {
  readonly headers: Headers;
}

function redirectLocation(response: RedirectResponseLike): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location header");
  }
  return new URL(location);
}

function expectConnectorErrorRedirect(
  response: RedirectResponseLike,
  args: { readonly connectorSlug: string; readonly message: string },
): void {
  const url = redirectLocation(response);
  expect(url.pathname).toBe("/connector/error");
  expect(url.searchParams.get("connectorSlug")).toBe(args.connectorSlug);
  expect(url.searchParams.get("message")).toBe(args.message);
}

const CONNECTOR_OAUTH_COOKIE_CLEARS = [
  "connector_oauth_state=; Max-Age=0; Path=/",
  "connector_oauth_pkce=; Max-Age=0; Path=/",
  "connector_oauth_context=; Max-Age=0; Path=/",
] as const;

describe("CONN-01 and CHAIN-CONNECTOR: connector discovery and manual grant lifecycle", () => {
  it("keeps a manual-grant connection and authorization when realtime publishing fails", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Manual Connector Agent",
    });
    const publishError = new Error("Ably channel rate limit exceeded");
    context.mocks.ably.publish
      .mockRejectedValueOnce(publishError)
      .mockRejectedValueOnce(publishError);

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "manual-agent-token" },
      agent.agentId,
    );

    await expect(
      connectorsApi.readConnectorBySlug(actor, "openai"),
    ).resolves.toMatchObject({
      id: connected.id,
      slug: "openai",
      connectionStatus: "connected",
    });
    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, agent.agentId),
    ).resolves.toContain("openai");
  });

  it("authorizes a manual-grant connector for the current default agent when no agent is requested", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    authOrgApi.acceptAgentStorageWrites();
    const { body } = await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Default Connector Agent",
    });

    await connectorsApi.connectManualGrant(actor, "openai", "api-token", {
      apiKey: "default-agent-token",
    });

    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, body.agentId),
    ).resolves.toContain("openai");
  });

  it("discovers, connects, reads, computes scope diff, and deletes a manual connector through APIs", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const noOrgActor = bdd.user({ orgId: null });

    const unauthenticated = await connectorsApi.requestListConnectors(
      null,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingOrg = await connectorsApi.requestListConnectors(
      noOrgActor,
      [401],
    );
    expectApiError(missingOrg.body);
    expect(missingOrg.body.error.code).toBe("UNAUTHORIZED");

    const initialList = await connectorsApi.listConnectors(actor);
    expect(initialList.connectors).toStrictEqual([]);
    expect(initialList.connectorProvidedBindings).toStrictEqual([]);

    const search = await connectorsApi.searchConnectors(actor, "OPENAI");
    const openaiSearch = search.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openaiSearch?.authMethods).toStrictEqual(["api-token"]);

    const missingOpenAi = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "openai",
      [404],
    );
    expectApiError(missingOpenAi.body);
    expect(missingOpenAi.body.error.code).toBe("NOT_FOUND");

    const badGrant = await connectorsApi.requestManualGrant(
      actor,
      "openai",
      "api-token",
      {
        apiKey: "sk-bdd-manual-secret",
        unknownField: "secret-value-should-not-echo",
      },
      { statuses: [400] },
    );
    expectApiError(badGrant.body);
    expect(badGrant.body.error.message).toContain("apiKey");
    expect(badGrant.body.error.message).not.toContain("unknownField");
    expectNoVisibleSecret(badGrant.body, "secret-value-should-not-echo");

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: " sk-bdd-manual-secret\n" },
    );
    expect(typeof connected.id).toBe("string");
    expectNoVisibleSecret(connected, "sk-bdd-manual-secret");

    const readBack = await connectorsApi.readConnectorBySlug(actor, "openai");
    expect(readBack).toMatchObject({
      slug: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
      oauthScopes: null,
    });
    expect(readBack.id).toBe(connected.id);
    expectNoVisibleSecret(readBack, "sk-bdd-manual-secret");

    const listAfterConnect = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listAfterConnect.connectors, "openai")?.id).toBe(
      connected.id,
    );
    expect(listAfterConnect.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "openai",
        authMethod: "api-token",
        namespace: "secrets",
        name: "OPENAI_TOKEN",
      }),
    );

    const storedSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      storedSecrets.find((secret) => {
        return secret.name === "OPENAI_TOKEN";
      }),
    ).toMatchObject({ type: "connector" });
    expectNoVisibleSecret(storedSecrets, "sk-bdd-manual-secret");

    await expect(
      connectorsApi.readScopeDiff(actor, "openai"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "openai");

    const deleted = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "openai",
      [404],
    );
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CONN-02: OAuth start and callback", () => {
  it("uses App callbacks for enabled connectors while returning structured callback results", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    const startResponse = await connectorsApi.requestOauthStart(
      actor,
      "github",
      "oauth",
      {
        statuses: [200],
        authorizeAgent: true,
        callbackTarget: "app",
      },
    );
    if (startResponse.status !== 200) {
      throw new Error(`Unexpected OAuth start status ${startResponse.status}`);
    }
    const authorizationUrl = new URL(startResponse.body.authorizationUrl);
    expect(
      new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "").pathname,
    ).toBe("/connectors/github/callback");
    const state = stateFromAuthorizationUrl(authorizationUrl.toString());

    const callbackResult = await connectorsApi.completeOauthCallbackResult(
      "github",
      {
        code: "github-app-success-code",
        state,
      },
    );
    expect(callbackResult.body).toStrictEqual({
      status: "success",
      username: "bdd-github-user",
    });
    expect(callbackResult.headers.get("cache-control")).toBe("no-store");
    expect(callbackResult.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toMatchObject({
      slug: "github",
      externalUsername: "bdd-github-user",
      connectionStatus: "connected",
    });

    const failedActor = bdd.user();
    const failedStartResponse = await connectorsApi.requestOauthStart(
      failedActor,
      "github",
      "oauth",
      {
        statuses: [200],
        authorizeAgent: true,
        callbackTarget: "app",
      },
    );
    if (failedStartResponse.status !== 200) {
      throw new Error(
        `Unexpected OAuth start status ${failedStartResponse.status}`,
      );
    }
    const failedAuthorizationUrl = new URL(
      failedStartResponse.body.authorizationUrl,
    );
    const failedState = stateFromAuthorizationUrl(
      failedAuthorizationUrl.toString(),
    );
    const failedCallbackResult =
      await connectorsApi.completeOauthCallbackResult("github", {
        error: "access_denied",
        error_description: "Provider denied access",
        state: failedState,
      });
    expect(failedCallbackResult.body).toStrictEqual({
      status: "error",
      message: "Provider denied access",
    });
    const failedConnector = await connectorsApi.requestReadConnectorBySlug(
      failedActor,
      "github",
      [404],
    );
    expectApiError(failedConnector.body);
    expect(failedConnector.body.error.code).toBe("NOT_FOUND");
  });

  it("starts GitHub OAuth, completes the callback, rejects replay visibly, and keeps safe connector state", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "github-client-id",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(connected).toMatchObject({
      slug: "github",
      authMethod: "oauth",
      externalId: "42",
      externalUsername: "bdd-github-user",
      externalEmail: "bdd-github@example.test",
      oauthScopes: ["repo", "project", "workflow"],
      connectionStatus: "connected",
    });
    expectNoVisibleSecret(connected, "github-access-github-success-code");

    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["repo", "project", "workflow"],
      storedScopes: ["repo", "project", "workflow"],
    });

    await connectorsApi.completeOauthCallback("github", {
      code: "github-replay-code",
      state,
    });
    const afterReplay = await connectorsApi.readConnectorBySlug(
      actor,
      "github",
    );
    expect(afterReplay.id).toBe(connected.id);
    expect(afterReplay.externalUsername).toBe("bdd-github-user");

    const failedActor = bdd.user();
    const failedStart = await connectorsApi.startOauth(
      failedActor,
      "github",
      "oauth",
    );
    const failedState = stateFromAuthorizationUrl(failedStart.authorizationUrl);
    await connectorsApi.completeOauthCallback("github", {
      error: "access_denied",
      error_description: "Provider denied access",
      state: failedState,
    });
    const failedConnector = await connectorsApi.requestReadConnectorBySlug(
      failedActor,
      "github",
      [404],
    );
    expectApiError(failedConnector.body);
    expect(failedConnector.body.error.code).toBe("NOT_FOUND");
  });

  it("supports exact reconnect and sibling adds across OAuth callbacks", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    const initialStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("github", {
      code: "github-initial-account-code",
      state: stateFromAuthorizationUrl(initialStart.authorizationUrl),
    });
    const initialConnection = await connectorsApi.readConnectorBySlug(
      actor,
      "github",
    );

    const reconnectStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
      undefined,
      {
        intent: "reconnect",
        connectionId: initialConnection.id,
      },
    );
    await connectorsApi.completeOauthCallback("github", {
      code: "github-reconnected-account-code",
      state: stateFromAuthorizationUrl(reconnectStart.authorizationUrl),
    });

    const reconnected = await connectorsApi.readConnectorBySlug(
      actor,
      "github",
    );
    expect(reconnected.id).toBe(initialConnection.id);

    mockGitHubConnectorOAuth({ userId: 84 });
    const mismatchedStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
      undefined,
      {
        intent: "reconnect",
        connectionId: initialConnection.id,
      },
    );
    const mismatchedCallback = await connectorsApi.completeOauthCallback(
      "github",
      {
        code: "github-mismatched-account-code",
        state: stateFromAuthorizationUrl(mismatchedStart.authorizationUrl),
      },
    );
    expectConnectorErrorRedirect(mismatchedCallback, {
      connectorSlug: "github",
      message: "Authorized account does not match the connector account",
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toMatchObject({
      id: initialConnection.id,
      externalId: initialConnection.externalId,
    });

    const siblingAdd = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
      undefined,
      { intent: "add", displayName: "Personal" },
    );
    await connectorsApi.completeOauthCallback("github", {
      code: "github-sibling-account-code",
      state: stateFromAuthorizationUrl(siblingAdd.authorizationUrl),
    });
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    expect(accounts).toHaveLength(2);
    expect(accounts).toContainEqual(
      expect.objectContaining({ displayName: "Personal", isDefault: false }),
    );
  });

  it("persists the callback-selected Datadog site through the public OAuth flow", async () => {
    const provider = mockDatadogConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: true,
    });

    const start = await connectorsApi.startOauth(actor, "datadog", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const callback = await connectorsApi.completeOauthCallback("datadog", {
      code: "datadog-success-code",
      state,
      domain: "us3.datadoghq.com",
    });
    expect(redirectLocation(callback).pathname).toBe("/connector/success");

    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("code")).toBe("datadog-success-code");
    const codeVerifier = provider.tokenBodies[0]?.get("code_verifier");
    expect(codeVerifier).toStrictEqual(expect.any(String));
    expect(codeVerifier?.length).toBeGreaterThanOrEqual(43);

    const connected = await connectorsApi.readConnectorBySlug(actor, "datadog");
    expect(connected).toMatchObject({
      slug: "datadog",
      authMethod: "oauth",
      externalId: "us3.datadoghq.com",
      externalUsername: "us3.datadoghq.com",
      oauthScopes: ["dashboards_read", "logs_read_index_data"],
    });
    expectNoVisibleSecret(connected, "bdd-datadog-access-token");
    expectNoVisibleSecret(connected, "bdd-datadog-refresh-token");

    await expect(
      connectorsApi.readScopeDiff(actor, "datadog"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [
        "dashboards_read",
        "events_read",
        "incident_read",
        "logs_read_index_data",
        "metrics_read",
        "monitors_read",
        "slos_read",
      ],
      storedScopes: [
        "dashboards_read",
        "events_read",
        "incident_read",
        "logs_read_index_data",
        "metrics_read",
        "monitors_read",
        "slos_read",
      ],
    });

    const catalog = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      catalog.body.connectors.find((connector) => {
        return connector.slug === "datadog";
      }),
    ).toMatchObject({
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
    });
  });

  it("rejects OAuth start requests that target unsupported auth methods", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const unauthenticated = await connectorsApi.requestOauthStart(
      null,
      "github",
      "oauth",
      { statuses: [401] },
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const wrongGrant = await connectorsApi.requestOauthStart(
      actor,
      "openai",
      "api-token",
      { statuses: [400] },
    );
    expectApiError(wrongGrant.body);
    expect(wrongGrant.body.error.message).toContain(
      "openai connector does not use an auth-code grant",
    );

    const missingMethod = await connectorsApi.requestOauthStart(
      actor,
      "github",
      "api-token",
      { statuses: [400] },
    );
    expectApiError(missingMethod.body);
    expect(missingMethod.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );
  });
});

describe("CONN-02: OAuth device authorization", () => {
  it("returns 403 when the selected device-auth runtime method is unavailable", async () => {
    await installCatalogWithUnavailableMethods({
      capabilityIdentityEnvName: "CAL_COM_OAUTH_CLIENT_ID",
      filteredAuthMethods: [
        {
          connectorSlug: "test-oauth-device",
          authMethodId: "oauth",
          reasons: ["missing-grant-provider"],
        },
      ],
    });
    const actor = createBddApi(context).user();

    const response = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "test-oauth-device connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("returns 403 when a device-auth runtime becomes unavailable before polling", async () => {
    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });
    const actor = createBddApi(context).user();
    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    await installCatalogWithUnavailableMethods({
      capabilityIdentityEnvName: "DEEL_OAUTH_CLIENT_ID",
      filteredAuthMethods: [
        {
          connectorSlug: "test-oauth-device",
          authMethodId: "oauth",
          reasons: ["missing-grant-provider"],
        },
      ],
    });

    const response = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "test-oauth-device connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("starts and completes a device authorization session, with state visible through connector APIs", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read provider-added",
    });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const visible = await connectorsApi.searchConnectors(
      actor,
      "test oauth device",
    );
    expect(
      visible.connectors.find((connector) => {
        return connector.slug === "test-oauth-device";
      })?.authMethods,
    ).toStrictEqual(["oauth", "api"]);

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "add" },
    );
    expect(session).toMatchObject({
      connectorSlug: "test-oauth-device",
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
    });
    expect(provider.deviceCodeBodies[0]?.get("scope")).toBe("read");

    const otherActor = bdd.user({ orgId: actor.orgId });
    const crossUserPoll = await connectorsApi.requestDeviceAuthPoll(
      otherActor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [404],
    );
    expectApiError(crossUserPoll.body);
    expect(crossUserPoll.body.error.code).toBe("NOT_FOUND");

    const poll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    );
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") {
      throw new Error(`Expected complete device auth, received ${poll.status}`);
    }
    expect(poll.connector).toMatchObject({
      slug: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read", "provider-added"],
    });

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(poll.connector.id);

    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "test-oauth-device")?.id).toBe(
      poll.connector.id,
    );

    mockTestOAuthDeviceConnectorProvider({ tokenScope: "" });
    const emptyReconnect = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: poll.connector.id },
    );
    const emptyPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      emptyReconnect.sessionId,
      emptyReconnect.sessionToken,
    );
    expect(emptyPoll.status).toBe("complete");
    if (emptyPoll.status !== "complete") {
      throw new Error(
        `Expected explicit-empty device auth, received ${emptyPoll.status}`,
      );
    }
    expect(emptyPoll.connector).toMatchObject({
      id: poll.connector.id,
      connectionStatus: "connected",
      oauthScopes: [],
    });

    const removedReconnect = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: poll.connector.id },
    );
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
    );
    const rejectedReconnect = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      removedReconnect.sessionId,
      removedReconnect.sessionToken,
    );
    expect(rejectedReconnect).toStrictEqual({
      status: "error",
      errorCode: "connector_account_rejected",
      errorMessage: "Connector account not found",
    });
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("re-polls the exact non-default account added by a device authorization session", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider();
    const actor = createBddApi(context).user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const defaultSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "add" },
    );
    const defaultPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      defaultSession.sessionId,
      defaultSession.sessionToken,
    );
    if (defaultPoll.status !== "complete") {
      throw new Error(
        `Expected complete default device auth, received ${defaultPoll.status}`,
      );
    }

    const siblingSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "add" },
    );
    const siblingPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      siblingSession.sessionId,
      siblingSession.sessionToken,
    );
    if (siblingPoll.status !== "complete") {
      throw new Error(
        `Expected complete sibling device auth, received ${siblingPoll.status}`,
      );
    }

    expect(siblingPoll.connector.id).not.toBe(defaultPoll.connector.id);
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "test-oauth-device",
    );
    expect(accounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultPoll.connector.id,
          isDefault: true,
        }),
        expect.objectContaining({
          id: siblingPoll.connector.id,
          isDefault: false,
        }),
      ]),
    );

    const rePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      siblingSession.sessionId,
      siblingSession.sessionToken,
    );
    if (rePoll.status !== "complete") {
      throw new Error(
        `Expected complete device auth replay, received ${rePoll.status}`,
      );
    }
    expect(rePoll.connector.id).toBe(siblingPoll.connector.id);
    expect(provider.tokenBodies).toHaveLength(2);

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
      siblingPoll.connector.id,
    );
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
      defaultPoll.connector.id,
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("starts and completes the Stripe CLI device authorization method", async () => {
    const stripeProvider = mockStripeCliDashboardAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      { mode: "live" },
    );
    expect(session).toMatchObject({
      connectorSlug: "stripe",
      status: "pending",
      userCode: "STRIPE-CLI",
      verificationUri:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      verificationUriComplete:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      expiresIn: 600,
      interval: 1,
    });
    expect(stripeProvider.startBodies[0]?.get("client_version")).toBe("1.42.1");
    expect(stripeProvider.startBodies[0]?.get("device_name")).toBe(
      "vm0-stripe-connector",
    );

    mockNow(now() + 2000);
    const poll = await connectorsApi.pollDeviceAuth(
      actor,
      "stripe",
      session.sessionId,
      session.sessionToken,
    );
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") {
      throw new Error(
        `Expected complete Stripe device auth, got ${poll.status}`,
      );
    }
    expect(poll.connector).toMatchObject({
      slug: "stripe",
      authMethod: "cli",
      externalId: "acct_bdd",
      externalUsername: "BDD Stripe",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
    });
    expect(JSON.stringify(poll)).not.toContain("rk_live_api456");
    expect(stripeProvider.pollCount()).toBe(1);
    clearMockNow();

    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "stripe")?.id).toBe(
      poll.connector.id,
    );
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "stripe",
        authMethod: "cli",
        namespace: "secrets",
        name: "STRIPE_TOKEN",
      }),
    );

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "stripe");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("validates device-auth identity, grant, options, and session boundaries without using rollout as authorization", async () => {
    const testOauthProvider = mockTestOAuthDeviceConnectorProvider();
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const switchlessActor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const unauthenticated = await connectorsApi.requestDeviceAuthStart(
      null,
      "test-oauth-device",
      "oauth",
      undefined,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const authCodeOnly = await connectorsApi.requestDeviceAuthStart(
      actor,
      "github",
      "oauth",
      undefined,
      [400],
    );
    expectApiError(authCodeOnly.body);
    expect(authCodeOnly.body.error.message).toBe(
      "github connector does not support a device-auth grant",
    );

    const noGrant = await connectorsApi.requestDeviceAuthStart(
      actor,
      "cloudinary",
      "oauth",
      undefined,
      [400],
    );
    expectApiError(noGrant.body);
    expect(noGrant.body.error.message).toBe(
      "cloudinary connector does not use an auth-code or device-auth grant",
    );

    const missingMethod = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api-token",
      undefined,
      [400],
    );
    expectApiError(missingMethod.body);
    expect(missingMethod.body.error.message).toBe(
      "test-oauth-device connector does not have api-token auth method",
    );

    const optionsUnsupported = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "oauth",
      { mode: "live" },
      [400],
    );
    expectApiError(optionsUnsupported.body);
    expect(optionsUnsupported.body.error.message).toBe(
      "test-oauth-device oauth device-auth start options are not supported: mode",
    );

    const invalidOptionValue = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      { environment: "production" },
      [400],
    );
    expectApiError(invalidOptionValue.body);
    expect(invalidOptionValue.body.error.message).toBe(
      "test-oauth-device api device-auth start option environment must be one of: test, live",
    );

    const privateOptionKey = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      { mode: "live" },
      [400],
    );
    expectApiError(privateOptionKey.body);
    expect(privateOptionKey.body.error.message).toBe(
      "test-oauth-device api device-auth start option(s) must use public IDs: environment",
    );

    const prototypeOptionKey = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      Object.fromEntries([["toString", "live"]]),
      [400],
    );
    expectApiError(prototypeOptionKey.body);
    expect(prototypeOptionKey.body.error.message).toBe(
      "test-oauth-device api device-auth start option(s) must use public IDs: environment",
    );

    const stripeDeviceAuth = await connectorsApi.requestDeviceAuthStart(
      actor,
      "stripe",
      "cli",
      { mode: "production" },
      [400],
    );
    expectApiError(stripeDeviceAuth.body);
    expect(stripeDeviceAuth.body.error.message).toBe(
      "stripe cli device-auth start option mode must be one of: test, live",
    );

    const switchlessStart = await connectorsApi.requestDeviceAuthStart(
      switchlessActor,
      "test-oauth-device",
      "oauth",
      undefined,
      [200],
    );
    expect(switchlessStart.body).toMatchObject({
      connectorSlug: "test-oauth-device",
      status: "pending",
    });
    expect(testOauthProvider.deviceCodeBodies).toHaveLength(1);

    const missingSession = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      randomUUID(),
      "wrong-session-token",
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.message).toBe(
      "OAuth device authorization session not found",
    );

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("supersedes, completes, and idempotently re-reads device authorization sessions per auth method", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read granted",
    });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    await connectorsApi.startDeviceAuth(actor, "test-oauth-device", "api", {
      environment: "live",
    });
    expect(provider.deviceCodeBodies[0]?.get("client_id")).toBe(
      "test-oauth-device-api-client",
    );
    expect(provider.deviceCodeBodies[0]?.get("mode")).toBe("live");

    const apiSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
    );
    expect(provider.deviceCodeBodies[1]?.get("mode")).toBe("test");

    const first = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    expect(first).toMatchObject({
      connectorSlug: "test-oauth-device",
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(first)).not.toContain("test-device:");

    const second = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );

    const superseded = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      first.sessionId,
      first.sessionToken,
    );
    expect(superseded).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });

    const apiPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      apiSession.sessionId,
      apiSession.sessionToken,
    );
    expect(apiPoll.status).toBe("complete");
    if (apiPoll.status !== "complete") {
      throw new Error(
        `Expected complete api-method device auth, received ${apiPoll.status}`,
      );
    }
    expect(apiPoll.connector.authMethod).toBe("api");
    const apiTokenBody = provider.tokenBodies.find((body) => {
      return body.get("device_code")?.endsWith(":read:test");
    });
    expect(apiTokenBody?.get("device_code")).toBe(
      "test-device:test-oauth-device-api-client:read:test",
    );

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
    );

    const completed = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      second.sessionId,
      second.sessionToken,
    );
    expect(completed.status).toBe("complete");
    if (completed.status !== "complete") {
      throw new Error(
        `Expected complete oauth device auth, received ${completed.status}`,
      );
    }
    expect(completed.connector).toMatchObject({
      slug: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read", "granted"],
    });
    expect(JSON.stringify(completed)).not.toContain("test-device-access");

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(completed.connector.id);
    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "test-oauth-device")?.id).toBe(
      completed.connector.id,
    );

    const tokenCallsBeforeRePoll = provider.tokenBodies.length;
    const rePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      second.sessionId,
      second.sessionToken,
    );
    expect(rePoll.status).toBe("complete");
    if (rePoll.status !== "complete") {
      throw new Error(
        `Expected idempotent complete device auth, received ${rePoll.status}`,
      );
    }
    expect(rePoll.connector.id).toBe(completed.connector.id);
    expect(provider.tokenBodies).toHaveLength(tokenCallsBeforeRePoll);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("walks pending, slow-down, interval, terminal, and expiry poll states through the API", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const intervalProvider = mockTestOAuthDeviceConnectorProvider({
      interval: 5,
    });
    const gated = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const gatedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      gated.sessionId,
      gated.sessionToken,
    );
    expect(gatedPoll).toStrictEqual({ status: "pending", interval: 5 });
    expect(intervalProvider.tokenBodies).toHaveLength(0);

    const pendingProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
    });
    const pending = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const pendingPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      pending.sessionId,
      pending.sessionToken,
    );
    expect(pendingPoll).toStrictEqual({ status: "pending", interval: 0 });
    const pendingRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      pending.sessionId,
      pending.sessionToken,
    );
    expect(pendingRePoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(pendingProvider.tokenBodies).toHaveLength(2);

    const slowDownProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "slow-down",
    });
    const slowDown = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const slowDownPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      slowDown.sessionId,
      slowDown.sessionToken,
    );
    expect(slowDownPoll).toStrictEqual({ status: "pending", interval: 5 });
    const slowDownRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      slowDown.sessionId,
      slowDown.sessionToken,
    );
    expect(slowDownRePoll).toStrictEqual({ status: "pending", interval: 5 });
    expect(slowDownProvider.tokenBodies).toHaveLength(1);

    const terminalCases = [
      {
        deviceCode: "denied",
        expected: {
          status: "denied",
          errorCode: "access_denied",
          errorMessage: "User denied the device authorization request",
        },
      },
      {
        deviceCode: "expired",
        expected: {
          status: "expired",
          errorCode: "expired_token",
          errorMessage: "Device authorization expired",
        },
      },
      {
        deviceCode: "error",
        expected: {
          status: "error",
          errorCode: "invalid_request",
          errorMessage: "Synthetic device authorization error",
        },
      },
      {
        deviceCode: "not-issued",
        expected: {
          status: "error",
          errorCode: "invalid_grant",
          errorMessage: "Unknown device authorization code",
        },
      },
    ] as const;

    for (const terminalCase of terminalCases) {
      const terminalProvider = mockTestOAuthDeviceConnectorProvider({
        deviceCode: terminalCase.deviceCode,
      });
      const session = await connectorsApi.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const poll = await connectorsApi.pollDeviceAuth(
        actor,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(poll).toStrictEqual(terminalCase.expected);
      const rePoll = await connectorsApi.pollDeviceAuth(
        actor,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(rePoll).toStrictEqual(terminalCase.expected);
      expect(terminalProvider.tokenBodies).toHaveLength(1);
    }

    mockTestOAuthDeviceConnectorProvider({ expiresIn: 0 });
    const expiring = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    mockNow(now() + 2000);
    const expiredPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      expiring.sessionId,
      expiring.sessionToken,
    );
    expect(expiredPoll).toStrictEqual({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
    });
    const expiredRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      expiring.sessionId,
      expiring.sessionToken,
    );
    expect(expiredRePoll).toStrictEqual({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
    });
    clearMockNow();

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("serializes concurrent device polls when a session is superseded", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthDeviceConnectorProvider();
    const deferred = mockDeferredTestOAuthTokenEndpoint(context.signal);

    const first = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const racedPollPromise = connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      first.sessionId,
      first.sessionToken,
    );
    const pollResults = await Promise.allSettled([
      (async () => {
        await deferred.started;

        const concurrentPoll = await connectorsApi.pollDeviceAuth(
          actor,
          "test-oauth-device",
          first.sessionId,
          first.sessionToken,
        );
        expect(concurrentPoll).toStrictEqual({
          status: "pending",
          interval: 0,
        });
        expect(deferred.calls()).toBe(1);

        await connectorsApi.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
        );
        deferred.release();
        const racedPoll = await racedPollPromise;
        expect(racedPoll).toStrictEqual({
          status: "error",
          errorCode: "session_superseded",
          errorMessage: "OAuth device authorization session was superseded",
        });
        expect(deferred.calls()).toBe(1);

        const nothingPersisted = await connectorsApi.requestReadConnectorBySlug(
          actor,
          "test-oauth-device",
          [404],
        );
        expectApiError(nothingPersisted.body);
        expect(nothingPersisted.body.error.code).toBe("NOT_FOUND");
      })().finally(() => {
        deferred.release();
      }),
      racedPollPromise,
    ]);
    for (const result of pollResults) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("restores a device poll claim after a provider failure", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
      tokenBehavior: "emptyJson",
    });
    const failing = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const providerFailure = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      failing.sessionId,
      failing.sessionToken,
      [500],
    );
    expect(providerFailure.body).toStrictEqual({
      error: "Internal server error",
    });

    const restoredProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
    });
    const restoredPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(restoredPoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(restoredProvider.tokenBodies).toHaveLength(1);

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("reclaims a stale device poll while its original request is pending", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });
    const staleDeferred = mockDeferredTestOAuthTokenEndpoint(context.signal);
    const stale = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const stalePollPromise = connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      stale.sessionId,
      stale.sessionToken,
    );
    const pollResults = await Promise.allSettled([
      (async () => {
        await staleDeferred.started;
        mockNow(now() + 31_000);

        const reclaimedPoll = await connectorsApi.pollDeviceAuth(
          actor,
          "test-oauth-device",
          stale.sessionId,
          stale.sessionToken,
        );
        expect(reclaimedPoll).toStrictEqual({ status: "pending", interval: 0 });
        expect(staleDeferred.calls()).toBe(2);
        staleDeferred.release();
        const stalePoll = await stalePollPromise;
        expect(stalePoll).toStrictEqual({ status: "pending", interval: 0 });
      })().finally(() => {
        staleDeferred.release();
        clearMockNow();
      }),
      stalePollPromise,
    ]);
    for (const result of pollResults) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("completes Base44 and Slock device sessions with provider metadata visible through connector reads", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();

    const base44Provider = mockBase44OAuthProvider();
    const base44Session = await connectorsApi.startDeviceAuth(
      actor,
      "base44",
      "oauth",
    );
    expect(base44Session).toMatchObject({
      connectorSlug: "base44",
      status: "pending",
      userCode: "BASE-44",
      verificationUri: "https://app.base44.com/device",
      verificationUriComplete:
        "https://app.base44.com/device?user_code=BASE-44",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(base44Session)).not.toContain("base44-device-code");
    expect(base44Provider.deviceCodeBodies).toStrictEqual([
      { client_id: "base44_cli", scope: "apps:read apps:write offline" },
    ]);

    const base44Poll = await connectorsApi.pollDeviceAuth(
      actor,
      "base44",
      base44Session.sessionId,
      base44Session.sessionToken,
    );
    expect(base44Poll.status).toBe("complete");
    if (base44Poll.status !== "complete") {
      throw new Error(
        `Expected complete Base44 device auth, received ${base44Poll.status}`,
      );
    }
    expect(JSON.stringify(base44Poll)).not.toContain("base44-access-token");
    expect(JSON.stringify(base44Poll)).not.toContain("base44-refresh-token");
    expect(base44Provider.tokenBodies).toHaveLength(1);
    expect(base44Provider.tokenBodies[0]?.get("client_id")).toBe("base44_cli");
    expect(base44Provider.tokenBodies[0]?.get("device_code")).toBe(
      "base44-device-code",
    );
    expect(base44Provider.userinfoAuthorizations).toStrictEqual([
      "Bearer base44-access-token",
    ]);

    const base44Connector = await connectorsApi.readConnectorBySlug(
      actor,
      "base44",
    );
    expect(base44Connector).toMatchObject({
      slug: "base44",
      authMethod: "oauth",
      externalId: "base44-user-id",
      externalUsername: "Base44 User",
      externalEmail: "base44@example.com",
      oauthScopes: ["apps:read", "apps:write", "offline"],
      connectionStatus: "connected",
    });
    expect(JSON.stringify(base44Connector)).not.toContain(
      "base44-access-token",
    );
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "base44");

    const slockProvider = mockSlockOAuthProvider();
    const slockSession = await connectorsApi.startDeviceAuth(
      actor,
      "slock",
      "oauth",
    );
    expect(slockSession).toMatchObject({
      connectorSlug: "slock",
      status: "pending",
      userCode: "SLOCK-1",
      verificationUri: "https://api.slock.ai/device",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(slockSession)).not.toContain("slock-device-code");

    const slockPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      slockSession.sessionId,
      slockSession.sessionToken,
    );
    expect(slockPoll.status).toBe("complete");
    if (slockPoll.status !== "complete") {
      throw new Error(
        `Expected complete Slock device auth, received ${slockPoll.status}`,
      );
    }
    expect(JSON.stringify(slockPoll)).not.toContain(slockProvider.accessToken);
    expect(JSON.stringify(slockPoll)).not.toContain("slock-refresh-token");

    const slockConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "slock",
    );
    expect(slockConnector).toMatchObject({
      slug: "slock",
      authMethod: "oauth",
      externalId: "slock-user-id",
      externalUsername: "Slock User",
      externalEmail: "slock@example.com",
      oauthScopes: [],
      connectionStatus: "connected",
    });
    if (!slockConnector.tokenExpiresAt) {
      throw new Error("Expected Slock token expiry to be visible");
    }
    const slockExpiryMs = Date.parse(slockConnector.tokenExpiresAt);
    expect(slockExpiryMs).toBeGreaterThan(now() + 850_000);
    expect(slockExpiryMs).toBeLessThanOrEqual(now() + 900_000);
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "slock");

    mockSlockOAuthProvider({ deviceCode: "userinfo-error" });
    const failing = await connectorsApi.startDeviceAuth(
      actor,
      "slock",
      "oauth",
    );
    const failedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(failedPoll).toStrictEqual({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
    const failedRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(failedRePoll).toStrictEqual({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
  });

  it("continues polls after the connector feature switch is disabled", async () => {
    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );

    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });

    const continuedPoll = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [200],
    );
    expect(continuedPoll.body).toStrictEqual({
      status: "pending",
      interval: 0,
    });
  });
});

describe("CONN-02: external-code authorization", () => {
  it("returns 403 when the external-code runtime method is unavailable", async () => {
    await installCatalogWithUnavailableMethods({
      capabilityIdentityEnvName: "CANVA_OAUTH_CLIENT_ID",
      filteredAuthMethods: [
        {
          connectorSlug: "aws",
          authMethodId: "cli",
          reasons: ["missing-grant-provider"],
        },
      ],
    });
    const actor = createBddApi(context).user();

    const response = await connectorsApi.requestExternalCodeStart(
      actor,
      "aws",
      "cli",
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "aws connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("returns 403 when an external-code runtime becomes unavailable before completion", async () => {
    const actor = createBddApi(context).user();
    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    await installCatalogWithUnavailableMethods({
      capabilityIdentityEnvName: "DOCUSIGN_OAUTH_CLIENT_ID",
      filteredAuthMethods: [
        {
          connectorSlug: "aws",
          authMethodId: "cli",
          reasons: ["missing-grant-provider"],
        },
      ],
    });

    const response = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: "bdd-code",
      },
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "aws connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("validates external-code auth, grant, and session boundaries without using rollout as authorization", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const missingSessionId = randomUUID();

    const unauthenticated = await connectorsApi.requestExternalCodeStart(
      null,
      "aws",
      "cli",
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const unsupportedGrant = await connectorsApi.requestExternalCodeStart(
      actor,
      "openai",
      "api-token",
      [400],
    );
    expectApiError(unsupportedGrant.body);
    expect(unsupportedGrant.body.error.message).toContain(
      "openai api-token auth method does not use an external-code grant",
    );

    const switchlessStart = await connectorsApi.requestExternalCodeStart(
      actor,
      "aws",
      "cli",
      [200],
    );
    expect(switchlessStart.body).toMatchObject({
      connectorSlug: "aws",
      status: "pending",
    });

    const invalidCompleteBody = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: missingSessionId,
        sessionToken: "bdd-session-token",
        code: "",
      },
      [400],
    );
    expectApiError(invalidCompleteBody.body);
    expect(invalidCompleteBody.body.error.code).toBe("BAD_REQUEST");

    const missingComplete = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: missingSessionId,
        sessionToken: "bdd-session-token",
        code: "bdd-code",
      },
      [404],
    );
    expectApiError(missingComplete.body);
    expect(missingComplete.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CONN-03: custom connectors and connector-owned secrets", () => {
  it("rejects credentialless manual auth across definition write boundaries", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const fields = [
      {
        key: "api_key",
        label: "API key",
        kind: "secret" as const,
        required: true,
      },
    ];
    const literalOnlyInjections = [
      {
        name: "Authorization",
        valueTemplate: "Bearer definition-literal",
      },
    ];
    const expectedMessage =
      "Manual custom connector injections must reference a declared secret or variable field";

    const rejectedCreate = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        displayName: "BDD Credentialless Create",
        prefixTemplates: [`https://${rand}.credentialless-create.test/v1/`],
        fields,
        headerInjections: literalOnlyInjections,
        queryInjections: [],
        authMode: "manual",
      },
      [400],
    );
    expectApiError(rejectedCreate.body);
    expect(rejectedCreate.body.error.message).toBe(expectedMessage);

    const valid = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Field-backed Manual",
      prefixTemplates: [`https://${rand}.field-backed.test/v1/`],
      fields,
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer public-prefix {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    expect(valid).toMatchObject({ connected: false });

    const rejectedUpdate = await connectorsApi.requestUpdateCustomConnector(
      admin,
      valid.id,
      {
        displayName: "BDD Credentialless Update",
        prefixTemplates: valid.prefixTemplates,
        fields,
        headerInjections: literalOnlyInjections,
        queryInjections: [],
        authMode: "manual",
      },
      [400],
    );
    expectApiError(rejectedUpdate.body);
    expect(rejectedUpdate.body.error.message).toBe(expectedMessage);
    await expect(
      connectorsApi.readCustomConnector(admin, valid.id),
    ).resolves.toMatchObject({
      displayName: valid.displayName,
      headerInjections: valid.headerInjections,
    });

    const rejectedProposal =
      await connectorsApi.requestSaveCustomConnectorProposal(
        admin,
        {
          proposal: {
            operation: "create",
            displayName: "BDD Credentialless Proposal",
            prefixTemplates: [
              `https://${rand}.credentialless-proposal.test/v1/`,
            ],
            fields,
            headerInjections: literalOnlyInjections,
            queryInjections: [],
          },
          values: [],
        },
        [400],
      );
    expectApiError(rejectedProposal.body);
    expect(rejectedProposal.body.error.message).toBe(expectedMessage);

    await connectorsApi.deleteCustomConnector(admin, valid.id);
  });

  it("requires an explicit member connection for optional manual fields", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Optional Manual Connection",
      prefixTemplates: [`https://${rand}.optional-manual.test/v1/`],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: false,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    expect(created).toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: [],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ connected: false });

    const connected = await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [],
    );
    expect(connected).toMatchObject({
      connected: true,
      configuredFieldKeys: [],
      missingRequiredFields: [],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: true,
      connectedAccountId: connected.connectedAccountId,
      connectedAccountUpdatedAt: expect.any(String),
    });

    const parent = await readCustomConnectorCredentialStorageParent(context, {
      orgId: admin.orgId ?? "",
      userId: admin.userId,
      customConnectorId: created.id,
    });
    const memberConnectorId = parent.connector?.id;
    if (!memberConnectorId) {
      throw new Error("Expected a stored custom connector account");
    }
    await setConnectorDefaultState(context, {
      orgId: admin.orgId ?? "",
      userId: admin.userId,
      connectorId: memberConnectorId,
      isDefault: false,
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ connected: false });

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, created.id);
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ connected: false });
    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("connects HTTP and MCP no-auth definitions with local credential-free accounts", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const httpDefinition = {
      displayName: "BDD Public HTTP",
      prefixTemplates: [
        `https://{{variables.region}}.${randomUUID()}.public-http.test/v1/`,
      ],
      fields: [
        {
          key: "region",
          label: "Region",
          kind: "variable" as const,
          required: true,
        },
      ],
      headerInjections: [],
      queryInjections: [],
      authMode: "none" as const,
    };
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const http = await connectorsApi.createCustomConnector(
      admin,
      httpDefinition,
    );
    expect(http).toMatchObject({
      kind: "http",
      authMode: "none",
      connected: false,
      missingRequiredFields: ["region"],
    });
    const connectedHttp = await connectorsApi.setCustomConnectorValues(
      admin,
      http.id,
      [{ key: "region", kind: "variable", value: "us" }],
    );
    expect(connectedHttp).toMatchObject({
      authMode: "none",
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["region"],
    });
    const httpStorage = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: http.id,
      },
    );
    expect(httpStorage.connector).toMatchObject({
      auth_method: "none",
      storage_version: 1,
      external_id: null,
      external_username: null,
      external_email: null,
      oauth_scopes: null,
      oauth_granted_scopes: null,
      token_expires_at: null,
    });
    expect(httpStorage.secrets).toStrictEqual([]);
    expect(httpStorage.variables).toStrictEqual([
      {
        name: "region",
        connector_id: httpStorage.connector?.id,
        value: "us",
      },
    ]);

    const mcp = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Public MCP",
      endpoint: `https://${randomUUID()}.public-mcp.test/server`,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "none",
    });
    expect(mcp).toMatchObject({
      kind: "mcp",
      authMode: "none",
      connected: false,
      missingRequiredFields: [],
    });
    const connectedMcp = await connectorsApi.setCustomConnectorValues(
      admin,
      mcp.id,
      [],
    );
    expect(connectedMcp).toMatchObject({
      authMode: "none",
      connected: true,
      configuredFieldKeys: [],
    });
    const mcpStorage = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: mcp.id,
      },
    );
    expect(mcpStorage.connector).toMatchObject({ auth_method: "none" });
    expect(mcpStorage.secrets).toStrictEqual([]);
    expect(mcpStorage.variables).toStrictEqual([]);

    const agent = await bdd.createAgent(admin, {
      displayName: "BDD No Auth Agent",
    });
    await expect(
      connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, [
        http.id,
        mcp.id,
      ]),
    ).resolves.toStrictEqual(expect.arrayContaining([http.id, mcp.id]));

    await expect(
      connectorsApi.readCustomConnector(admin, http.id),
    ).resolves.toMatchObject({ authMode: "none", connected: true });
    await expect(
      connectorsApi.setCustomConnectorValues(admin, http.id, [
        { key: "region", kind: "variable", value: "eu" },
      ]),
    ).resolves.toMatchObject({ authMode: "none", connected: true });

    const manualHttp = await connectorsApi.updateCustomConnector(
      admin,
      http.id,
      {
        displayName: httpDefinition.displayName,
        prefixTemplates: httpDefinition.prefixTemplates,
        fields: [
          ...httpDefinition.fields,
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
        authMode: "manual",
      },
    );
    expect(manualHttp).toMatchObject({
      authMode: "manual",
      connected: false,
      storageVersion: 2,
    });
    const restoredNone = await connectorsApi.updateCustomConnector(
      admin,
      http.id,
      httpDefinition,
    );
    expect(restoredNone).toMatchObject({
      authMode: "none",
      connected: false,
      storageVersion: 3,
    });

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, http.id);
    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, mcp.id);
    await connectorsApi.deleteCustomConnector(admin, http.id);
    await connectorsApi.deleteCustomConnector(admin, mcp.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("uses exact reconnect semantics for HTTP and MCP custom connectors", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const definitions = [
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD HTTP Account Mutation",
        prefixTemplates: [
          `https://${randomUUID()}.account-mutation.example.test/v1/`,
        ],
      }),
      manualMcpConnectorBody({
        displayName: "BDD MCP Account Mutation",
        endpoint: `https://${randomUUID()}.account-mutation.example.test/mcp`,
      }),
    ];

    for (const definition of definitions) {
      const connector = await connectorsApi.createCustomConnector(
        admin,
        definition,
      );
      const connected = await connectorsApi.requestSetCustomConnectorValues(
        admin,
        connector.id,
        [{ key: "secret", kind: "secret", value: "unlabeled-secret" }],
        [200],
        { intent: "add" },
      );
      expect(connected.body).toMatchObject({
        connected: true,
        connectedAccountId: expect.any(String),
      });
      if (connected.status !== 200 || !connected.body.connectedAccountId) {
        throw new Error("Expected a connected custom connector account");
      }
      const connectedAccountId = connected.body.connectedAccountId;

      const replaced = await connectorsApi.requestSetCustomConnectorValues(
        admin,
        connector.id,
        [{ key: "secret", kind: "secret", value: "replacement-secret" }],
        [200],
        {
          intent: "reconnect",
          connectionId: connectedAccountId,
        },
      );
      expect(replaced.body).toMatchObject({
        connected: true,
        connectedAccountId,
      });

      const sibling = await connectorsApi.requestSetCustomConnectorValues(
        admin,
        connector.id,
        [{ key: "secret", kind: "secret", value: "sibling-secret" }],
        [200],
        { intent: "add", displayName: "Personal" },
      );
      expect(sibling.body).toMatchObject({ connected: true });

      await expect(
        connectorsApi.readCustomConnector(admin, connector.id),
      ).resolves.toMatchObject({ connected: true });
      await connectorsApi.deleteCustomConnector(admin, connector.id);
    }
  });

  it("stores an OAuth app config and lets members authorize", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    const provider = mockCustomConnectorOAuth2Provider(context);
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const agent = await bdd.createAgent(member, {
      displayName: "BDD Custom OAuth Agent",
    });
    const clientId = "bdd-custom-oauth-client-id";
    const clientSecret = "bdd-custom-oauth-client-secret";
    const connectorBody = {
      displayName: "BDD OAuth Connector",
      prefixTemplates: ["https://multi-auth.example.test/v1/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth" as const,
      permissionBundleRef: "builtin:slack@1",
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId,
        clientSecret,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "none" as const,
        scopes: ["read", "write"],
        authorizationParams: {},
      },
    };

    const missingCredentials = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...connectorBody,
        oauthConfig: {
          ...connectorBody.oauthConfig,
          clientSecret: undefined,
        },
      },
      [400],
    );
    expectApiError(missingCredentials.body);
    expect(missingCredentials.body.error.message).toContain(
      "client secret is required",
    );
    const created = await connectorsApi.createCustomConnector(
      admin,
      connectorBody,
    );
    expect(created).toMatchObject({
      authMode: "oauth",
      storageVersion: 1,
      oauthConfig: {
        clientId,
        scopes: ["read", "write"],
      },
      connected: false,
    });
    expect(created).not.toHaveProperty("oauthSetup");
    expectNoVisibleSecret(created, clientSecret);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.not.toHaveProperty("definition_oauth_setup");
    const expectedGrant = {
      customConnectorId: created.id,
      permissionNames: ["chat:write"],
    };
    await connectorsApi.requestUpdateAgentCustomConnectorGrants(
      member,
      agent.agentId,
      [expectedGrant],
      [200],
    );

    const unlabeledAdd = await connectorsApi.requestStartCustomConnectorOAuth2(
      member,
      created.id,
      [200],
      agent.agentId,
      { intent: "add" },
    );
    if ("error" in unlabeledAdd.body) {
      throw new Error("Expected an unlabeled custom OAuth addition to start");
    }
    if (unlabeledAdd.body.result !== "authorization") {
      throw new Error("Expected an unlabeled custom OAuth authorization");
    }
    const connectionId = unlabeledAdd.body.connectionId;
    expect(connectionId).toStrictEqual(expect.any(String));
    const authorizationUrl = unlabeledAdd.body.authorizationUrl;
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      provider.authorizationUrl,
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe(clientId);
    expect(authorization.searchParams.get("scope")).toBe("read write");
    const redirectUri = authorization.searchParams.get("redirect_uri");
    if (!redirectUri) {
      throw new Error("Expected custom connector OAuth redirect URI");
    }
    expect(redirectUri).toBe(
      "https://app.okou.test/connectors/custom/callback",
    );
    expectNoVisibleSecret(authorizationUrl, clientSecret);

    const oauthState = stateFromAuthorizationUrl(authorizationUrl);
    await expect(
      readCustomConnectorOAuthStorageState(context, oauthState),
    ).resolves.toMatchObject({
      custom_oauth_state: {
        storage_version: 1,
        context_storage_version: 1,
      },
    });
    const runtimeUpdated = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: "BDD OAuth Connector Runtime Updated",
        prefixTemplates: ["https://multi-auth.example.test/v2/"],
        fields: created.fields,
        headerInjections: created.headerInjections,
        queryInjections: created.queryInjections,
        authMode: "oauth",
        oauthConfig: {
          ...connectorBody.oauthConfig,
          clientSecret: undefined,
        },
        storageVersion: 1,
      },
    );
    expect(runtimeUpdated).toMatchObject({ storageVersion: 1 });

    clearConnectorInvalidationMocks();
    const callback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "bdd-custom-oauth-code",
        state: oauthState,
      });
    expectCustomConnectorInvalidations([member.userId]);
    expect(callback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("grant_type")).toBe(
      "authorization_code",
    );
    expect(provider.tokenBodies[0]?.get("code")).toBe("bdd-custom-oauth-code");
    expect(provider.tokenBodies[0]?.get("client_id")).toBe(
      "bdd-custom-oauth-client-id",
    );
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(clientSecret);
    expect(provider.authorizationHeaders).toStrictEqual([null]);
    expect(context.mocks.nodeRequest.pinnedAddresses).toContain(
      "93.184.216.34",
    );

    const initialStorage = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(member),
        userId: member.userId,
        customConnectorId: created.id,
      },
    );
    expect(initialStorage).toMatchObject({
      connector: {
        storage_version: 1,
      },
    });
    if (!initialStorage.connector) {
      throw new Error("Expected custom OAuth connector storage");
    }
    expect(initialStorage.connector.id).toBe(connectionId);

    const oauthConnected = await connectorsApi.listCustomConnectors(member);
    expect(
      oauthConnected.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: true,
    });
    expectNoVisibleSecret(oauthConnected, clientSecret);
    expectNoVisibleSecret(oauthConnected, "custom-oauth-initial-access-token");
    expectNoVisibleSecret(oauthConnected, "custom-oauth-refresh-token");
    await expect(
      connectorsApi.readAgentCustomConnectors(member, agent.agentId),
    ).resolves.toContain(created.id);
    await expect(
      connectorsApi.readAgentCustomConnectorGrants(member, agent.agentId),
    ).resolves.toContainEqual(expectedGrant);

    const replacementUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
      agent.agentId,
      {
        intent: "reconnect",
        connectionId: initialStorage.connector.id,
      },
    );
    await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
      code: "bdd-custom-oauth-replacement-code",
      state: stateFromAuthorizationUrl(replacementUrl),
    });
    const replacementStorage = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(member),
        userId: member.userId,
        customConnectorId: created.id,
      },
    );
    expect(replacementStorage.connector?.id).toBe(initialStorage.connector.id);
    expect(provider.tokenBodies).toHaveLength(2);
    expect(provider.tokenBodies[1]?.get("code")).toBe(
      "bdd-custom-oauth-replacement-code",
    );
    await expect(
      connectorsApi.readAgentCustomConnectorGrants(member, agent.agentId),
    ).resolves.toContainEqual(expectedGrant);

    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(member),
      userId: member.userId,
      customConnectorId: created.id,
      authMethod: "manual",
      storageVersion: 1,
    });
    const authMethodMismatch = await connectorsApi.listCustomConnectors(member);
    expect(
      authMethodMismatch.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: false,
      missingRequiredFields: ["oauth"],
    });
    await expect(
      connectorsApi.readAgentCustomConnectorGrants(member, agent.agentId),
    ).resolves.toContainEqual(expectedGrant);
    await expect(
      connectorsApi.readAgentCustomConnectors(member, agent.agentId),
    ).resolves.toContain(created.id);

    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(member),
      userId: member.userId,
      customConnectorId: created.id,
      authMethod: "oauth",
      storageVersion: 1,
    });
    const restoredConnection = await connectorsApi.listCustomConnectors(member);
    expect(
      restoredConnection.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({ connected: true });

    const removedReconnectUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
      undefined,
      {
        intent: "reconnect",
        connectionId: initialStorage.connector.id,
      },
    );
    await connectorsApi.deleteDefaultCustomConnectorAccount(member, created.id);
    const removedReconnect =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "bdd-custom-oauth-removed-reconnect-code",
        state: stateFromAuthorizationUrl(removedReconnectUrl),
      });
    expect(removedReconnect.body).toStrictEqual({
      status: "error",
      message: "Connector account not found",
    });
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(member),
        userId: member.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({ connector: null });
    const disconnectedConnection =
      await connectorsApi.listCustomConnectors(member);
    expect(
      disconnectedConnection.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["oauth"],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(member, agent.agentId),
    ).resolves.toContain(created.id);

    const reconnectUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
      agent.agentId,
    );
    await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
      code: "bdd-custom-oauth-reconnect-code",
      state: stateFromAuthorizationUrl(reconnectUrl),
    });
    expect(provider.tokenBodies).toHaveLength(4);
    expect(provider.tokenBodies[3]?.get("code")).toBe(
      "bdd-custom-oauth-reconnect-code",
    );
    await expect(
      connectorsApi.readCustomConnector(member, created.id),
    ).resolves.toMatchObject({ connected: true });
    await expect(
      connectorsApi.readAgentCustomConnectors(member, agent.agentId),
    ).resolves.toContain(created.id);

    await connectorsApi.deleteCustomConnector(admin, created.id);
    await bdd.deleteAgent(member, agent.agentId);
  });

  it.each([
    {
      name: "reported subset",
      tokenScope: "read",
      expectedScopes: ["read"],
    },
    {
      name: "reported supplemental grant",
      tokenScope: "read write admin",
      expectedScopes: ["read", "write", "admin"],
    },
    {
      name: "omitted token scope",
      tokenScope: undefined,
      expectedScopes: ["read", "write"],
    },
  ] as const)(
    "persists the $name for a standard custom OAuth connection",
    async ({ tokenScope, expectedScopes }) => {
      mockEnv("APP_URL", "https://app.okou.test");
      const provider =
        tokenScope === undefined
          ? mockCustomConnectorOAuth2Provider(context)
          : mockCustomConnectorOAuth2Provider(context, {
              initialScope: tokenScope,
            });
      const admin = createBddApi(context).user({ orgRole: "org:admin" });
      await connectorsApi.updateFeatureSwitches(admin, {});
      const connector = await connectorsApi.createCustomConnector(admin, {
        displayName: `BDD OAuth Scope ${randomUUID()}`,
        prefixTemplates: [
          `https://${randomUUID()}.oauth-scope.example.test/v1/`,
        ],
        fields: [],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{oauth.access_token}}",
          },
        ],
        queryInjections: [],
        authMode: "oauth",
        oauthConfig: {
          providerAdapter: "standard",
          clientId: "oauth-scope-client-id",
          clientSecret: "oauth-scope-client-secret",
          authorizationUrl: provider.authorizationUrl,
          tokenUrl: provider.tokenUrl,
          tokenEndpointAuthMethod: "client_secret_post",
          pkceMethod: "none",
          scopes: ["read", "write"],
          authorizationParams: {},
        },
      });

      const authorizationUrl = await connectorsApi.startCustomConnectorOAuth2(
        admin,
        connector.id,
      );
      await connectorsApi.completeCustomConnectorOAuth2Callback({
        code: "oauth-scope-authorization-code",
        state: stateFromAuthorizationUrl(authorizationUrl),
      });

      const accounts = await connectorsApi.listCustomConnectorAccounts(
        admin,
        connector.id,
      );
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.oauthScopes).toStrictEqual(expectedScopes);

      await connectorsApi.deleteCustomConnector(admin, connector.id);
    },
  );

  it("removes OAuth tokens when manual credentials replace the connection", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialExpiresIn: 3600,
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const oauthDefinition = {
      displayName: "BDD OAuth to Manual Connector",
      prefixTemplates: ["https://oauth-to-manual.example.test/v1/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth" as const,
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId: "oauth-to-manual-client-id",
        clientSecret: "oauth-to-manual-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "none" as const,
        scopes: ["read"],
        authorizationParams: {},
      },
    };
    const created = await connectorsApi.createCustomConnector(
      admin,
      oauthDefinition,
    );
    const authorizationUrl = await connectorsApi.startCustomConnectorOAuth2(
      admin,
      created.id,
    );
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "oauth-to-manual-code",
      state: stateFromAuthorizationUrl(authorizationUrl),
    });
    const [oauthAccount] = await connectorsApi.listCustomConnectorAccounts(
      admin,
      created.id,
    );
    if (!oauthAccount) {
      throw new Error("Expected the custom OAuth account");
    }
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ connected: true, storageVersion: 1 });

    const manual = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: oauthDefinition.displayName,
        prefixTemplates: oauthDefinition.prefixTemplates,
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
        authMode: "manual",
      },
    );
    expect(manual).toMatchObject({ connected: false, storageVersion: 2 });
    await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [{ key: "api_key", kind: "secret", value: "manual-api-key" }],
      { intent: "reconnect", connectionId: oauthAccount.id },
    );

    const oauthAgain = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      oauthDefinition,
    );
    expect(oauthAgain).toMatchObject({ connected: false, storageVersion: 3 });
    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: created.id,
      authMethod: "oauth",
      storageVersion: 3,
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: false,
      missingRequiredFields: ["oauth"],
    });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("keeps OAuth state target-scoped and aligns Custom lifecycle with Builtin", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    mockGitHubConnectorOAuth();
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialExpiresIn: 3600,
    });
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const owner = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const peer = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const host = uniqueSlug("oauth-state").slice(1);
    const connector = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD OAuth State Connector",
      prefixTemplates: [`https://${host}.example.test/v1/`],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "bdd-oauth-state-client-id",
        clientSecret: "bdd-oauth-state-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });

    const legacyCustomState = `legacy-custom-oauth-${randomUUID()}`;
    await seedCustomConnectorOAuthStateContext(context, {
      state: legacyCustomState,
      orgId: requiredOrgId(owner),
      userId: owner.userId,
      customConnectorId: connector.id,
      storageVersion: 1,
      redirectUri:
        "https://app.okou.test/api/custom-connectors/oauth2/callback",
      oauthContext: {
        oauthSetup: "custom",
        connectorId: connector.id,
        storageVersion: 1,
      },
    });
    await expect(
      readCustomConnectorOAuthStorageState(context, legacyCustomState),
    ).resolves.toMatchObject({
      custom_oauth_state: { context_valid: false },
    });
    const legacyCustomCallback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "legacy-custom-oauth-code",
        state: legacyCustomState,
      });
    expect(legacyCustomCallback.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });

    const customAuthorizationUrl =
      await connectorsApi.startCustomConnectorOAuth2(owner, connector.id);
    const customState = stateFromAuthorizationUrl(customAuthorizationUrl);
    const wrongBuiltinCallback = await connectorsApi.completeOauthCallback(
      "github",
      { code: "wrong-source-code", state: customState },
    );
    expectConnectorErrorRedirect(wrongBuiltinCallback, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const customMissingCode =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        state: customState,
      });
    expect(customMissingCode.body).toStrictEqual({
      status: "error",
      message: "Missing authorization code",
    });
    expect(provider.tokenBodies).toHaveLength(0);

    const customSuccess =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-success-code",
        state: customState,
      });
    expect(customSuccess.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("code")).toBe("custom-success-code");
    const ownerConnectors = await connectorsApi.listCustomConnectors(owner);
    expect(
      ownerConnectors.find((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toMatchObject({ connected: true });
    const peerConnectors = await connectorsApi.listCustomConnectors(peer);
    expect(
      peerConnectors.find((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toMatchObject({ connected: false });

    const customReplay =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-replay-code",
        state: customState,
      });
    expect(customReplay.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    expect(provider.tokenBodies).toHaveLength(1);

    const deniedAuthorizationUrl =
      await connectorsApi.startCustomConnectorOAuth2(owner, connector.id);
    const deniedState = stateFromAuthorizationUrl(deniedAuthorizationUrl);
    const denied =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        error: "access_denied",
        error_description: "Provider denied access",
        state: deniedState,
      });
    expect(denied.body).toStrictEqual({
      status: "error",
      message: "Provider denied access",
    });
    const deniedReplay =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-denied-replay-code",
        state: deniedState,
      });
    expect(deniedReplay.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    expect(provider.tokenBodies).toHaveLength(1);

    const builtinAuthorization = await connectorsApi.startOauth(
      peer,
      "github",
      "oauth",
    );
    const builtinState = stateFromAuthorizationUrl(
      builtinAuthorization.authorizationUrl,
    );
    const wrongCustomCallback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        state: builtinState,
      });
    expect(wrongCustomCallback.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });

    const builtinSuccess = await connectorsApi.completeOauthCallback("github", {
      code: "github-correct-source-code",
      state: builtinState,
    });
    expect(redirectLocation(builtinSuccess).pathname).toBe(
      "/connector/success",
    );
    await expect(
      connectorsApi.readConnectorBySlug(peer, "github"),
    ).resolves.toMatchObject({
      slug: "github",
      connectionStatus: "connected",
    });

    const expiringAuthorizationUrl =
      await connectorsApi.startCustomConnectorOAuth2(peer, connector.id);
    const expiringState = stateFromAuthorizationUrl(expiringAuthorizationUrl);
    mockNow(now() + 16 * 60 * 1000);
    const expiredStatus =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        state: expiringState,
      });
    const expiredClaim =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "expired-custom-code",
        state: expiringState,
      });
    clearMockNow();
    expect(expiredStatus.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    expect(expiredClaim.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    expect(provider.tokenBodies).toHaveLength(1);
    const peerAfterExpiry = await connectorsApi.listCustomConnectors(peer);
    expect(
      peerAfterExpiry.find((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toMatchObject({ connected: false });

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(peer, "github");
    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it("reuses confidential OAuth for MCP and gates callback writes", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    const provider = mockCustomConnectorOAuth2Provider(context);
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    await connectorsApi.updateFeatureSwitches(member, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const agent = await bdd.createAgent(member, {
      displayName: "BDD MCP OAuth Agent",
    });
    const clientSecret = "bdd-mcp-oauth-client-secret";
    const definition = {
      kind: "mcp" as const,
      displayName: "BDD MCP OAuth",
      endpoint: "https://oauth-mcp.example.test/server",
      transport: "streamable-http" as const,
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth" as const,
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId: "bdd-mcp-oauth-client",
        clientSecret,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "none" as const,
        scopes: ["read"],
        authorizationParams: {},
      },
    };

    const missingSecret = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...definition,
        oauthConfig: { ...definition.oauthConfig, clientSecret: undefined },
      },
      [400],
    );
    expectApiError(missingSecret.body);
    expect(missingSecret.body.error.message).toContain(
      "client secret is required",
    );

    const created = await connectorsApi.createCustomConnector(
      admin,
      definition,
    );
    expect(created).toMatchObject({
      kind: "mcp",
      authMode: "oauth",
      endpoint: definition.endpoint,
      storageVersion: 1,
      connected: false,
    });
    expectNoVisibleSecret(created, clientSecret);

    const authorizationUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
      agent.agentId,
    );
    const oauthState = stateFromAuthorizationUrl(authorizationUrl);
    const moved = await connectorsApi.updateCustomConnector(admin, created.id, {
      ...definition,
      endpoint: "https://oauth-mcp.example.test/v2/server",
      oauthConfig: {
        ...definition.oauthConfig,
        clientSecret: undefined,
      },
    });
    expect(moved).toMatchObject({
      id: created.id,
      endpoint: "https://oauth-mcp.example.test/v2/server",
      storageVersion: 1,
    });

    const callback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "bdd-mcp-oauth-code",
        state: oauthState,
      });
    expect(callback.body).toStrictEqual({ status: "success", username: null });
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(clientSecret);
    await expect(
      connectorsApi.readAgentCustomConnectors(member, agent.agentId),
    ).resolves.toContain(created.id);
    const connected = await connectorsApi.readCustomConnector(
      member,
      created.id,
    );
    expect(connected).toMatchObject({ connected: true });
    expectNoVisibleSecret(connected, clientSecret);

    const blockedCallbackUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
    );
    await connectorsApi.updateFeatureSwitches(member, {
      [FeatureSwitchKey.CustomConnectorMcp]: false,
    });
    const blockedCallback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "bdd-mcp-oauth-blocked-code",
        state: stateFromAuthorizationUrl(blockedCallbackUrl),
      });
    expect(blockedCallback.body).toStrictEqual({
      status: "error",
      message: "MCP custom connector management is not enabled",
    });
    expect(provider.tokenBodies).toHaveLength(1);

    const blockedStart = await connectorsApi.requestStartCustomConnectorOAuth2(
      member,
      created.id,
      [403],
    );
    expectApiError(blockedStart.body);
    expect(blockedStart.body.error.code).toBe("FORBIDDEN");

    await connectorsApi.deleteDefaultCustomConnectorAccount(member, created.id);
    await connectorsApi.deleteCustomConnector(admin, created.id);
    await bdd.deleteAgent(member, agent.agentId);
  });

  it("connects an Automatic MCP OAuth account through Okou CIMD", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Automatic OAuth Agent",
    });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Automatic CIMD",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const authorizationUrl = new URL(
      await connectorsApi.startCustomConnectorOAuth2(
        admin,
        connector.id,
        agent.agentId,
      ),
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${provider.issuer}/authorize`,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/custom/callback",
    );
    expect(authorizationUrl.searchParams.get("resource")).toBe(
      provider.endpoint,
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("read write");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );

    const completed =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "automatic-cimd-code",
        state: stateFromAuthorizationUrl(authorizationUrl.toString()),
        iss: provider.issuer,
      });
    expect(completed.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(provider.registrationBodies).toHaveLength(0);
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("resource")).toBe(provider.endpoint);
    expect(provider.tokenBodies[0]?.get("client_id")).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    await expect(
      connectorsApi.readCustomConnector(admin, connector.id),
    ).resolves.toMatchObject({ connected: true, authMode: "automatic" });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toContain(connector.id);
    const accounts = await connectorsApi.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.oauthScopes).toStrictEqual(["read", "write"]);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("resolves Automatic MCP auth and reconnects the exact account across none and OAuth", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "none",
    });
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Automatic auth Agent",
    });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Automatic auth outcomes",
      endpoint: "https://automatic-mcp.example.test/server",
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const noAuth = await connectorsApi.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
      agent.agentId,
    );
    if ("error" in noAuth.body || noAuth.body.result !== "connected") {
      throw new Error("Expected Automatic MCP no-auth connection");
    }
    const connectionId = noAuth.body.connectedAccountId;
    expect(noAuth.body.connector).toMatchObject({
      id: connector.id,
      authMode: "automatic",
      connected: true,
      connectedAccountId: connectionId,
    });
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toMatchObject([
      { id: connectionId, authMethod: "none", connectionStatus: "connected" },
    ]);
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toContain(connector.id);

    const oauthProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const authorization = await connectorsApi.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
      undefined,
      { intent: "reconnect", connectionId },
    );
    if (
      "error" in authorization.body ||
      authorization.body.result !== "authorization"
    ) {
      throw new Error("Expected Automatic MCP OAuth authorization");
    }
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toMatchObject([{ id: connectionId, authMethod: "none" }]);
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "automatic-transition-code",
      state: stateFromAuthorizationUrl(authorization.body.authorizationUrl),
      iss: oauthProvider.issuer,
    });
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toMatchObject([
      { id: connectionId, authMethod: "oauth", connectionStatus: "connected" },
    ]);
    await expect(
      readAutomaticOAuthBindingState(context, connectionId),
    ).resolves.toMatchObject({ exists: true, valid: true });

    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "none",
    });
    const restoredNoAuth =
      await connectorsApi.requestStartCustomConnectorOAuth2(
        admin,
        connector.id,
        [200],
        undefined,
        { intent: "reconnect", connectionId },
      );
    if (
      "error" in restoredNoAuth.body ||
      restoredNoAuth.body.result !== "connected"
    ) {
      throw new Error("Expected Automatic MCP no-auth reconnect");
    }
    expect(restoredNoAuth.body.connectedAccountId).toBe(connectionId);
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toMatchObject([
      { id: connectionId, authMethod: "none", connectionStatus: "connected" },
    ]);
    await expect(
      readAutomaticOAuthBindingState(context, connectionId),
    ).resolves.toMatchObject({ exists: false, valid: false });

    const addedNoAuth = await connectorsApi.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
      undefined,
      { intent: "add", displayName: "No-auth sibling" },
    );
    if (
      "error" in addedNoAuth.body ||
      addedNoAuth.body.result !== "connected"
    ) {
      throw new Error("Expected an added Automatic MCP no-auth account");
    }
    expect(addedNoAuth.body.connectedAccountId).not.toBe(connectionId);
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toHaveLength(2);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("rejects Automatic OAuth callback authority drift before token exchange", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const definition = {
      kind: "mcp" as const,
      displayName: "BDD Automatic Callback Binding",
      endpoint: provider.endpoint,
      transport: "streamable-http" as const,
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic" as const,
    };
    const connector = await connectorsApi.createCustomConnector(
      admin,
      definition,
    );

    const missingIssuerAuthorization =
      await connectorsApi.startCustomConnectorOAuth2(admin, connector.id);
    const missingIssuer =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "automatic-missing-issuer-code",
        state: stateFromAuthorizationUrl(missingIssuerAuthorization),
      });
    expect(missingIssuer.body).toStrictEqual({
      status: "error",
      message: "OAuth authorization issuer did not match - please try again",
    });

    const wrongIssuerAuthorization =
      await connectorsApi.startCustomConnectorOAuth2(admin, connector.id);
    const wrongIssuer =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "automatic-wrong-issuer-code",
        state: stateFromAuthorizationUrl(wrongIssuerAuthorization),
        iss: "https://other-issuer.example.test",
      });
    expect(wrongIssuer.body).toStrictEqual({
      status: "error",
      message: "OAuth authorization issuer did not match - please try again",
    });

    const changedEndpointAuthorization =
      await connectorsApi.startCustomConnectorOAuth2(admin, connector.id);
    await expect(
      connectorsApi.updateCustomConnector(admin, connector.id, {
        ...definition,
        endpoint: "https://replacement-mcp.example.test/server",
      }),
    ).resolves.toMatchObject({ storageVersion: 2 });
    const changedEndpoint =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "automatic-changed-endpoint-code",
        state: stateFromAuthorizationUrl(changedEndpointAuthorization),
        iss: provider.issuer,
      });
    expect(changedEndpoint.body).toStrictEqual({
      status: "error",
      message:
        "Custom connector OAuth configuration changed - please try again",
    });
    expect(provider.tokenBodies).toHaveLength(0);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it("reuses one DCR client across Automatic MCP OAuth accounts", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Automatic DCR",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const firstAuthorization = await connectorsApi.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    expect(new URL(firstAuthorization).searchParams.get("client_id")).toBe(
      "automatic-dcr-client",
    );
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "automatic-dcr-first-code",
      state: stateFromAuthorizationUrl(firstAuthorization),
      iss: provider.issuer,
    });
    const secondAuthorization = await connectorsApi.startCustomConnectorOAuth2(
      admin,
      connector.id,
      undefined,
      { intent: "add", displayName: "Second" },
    );
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "automatic-dcr-second-code",
      state: stateFromAuthorizationUrl(secondAuthorization),
      iss: provider.issuer,
    });

    expect(provider.registrationBodies).toHaveLength(1);
    expect(provider.registrationBodies[0]).toMatchObject({
      redirect_uris: ["https://app.okou.ai/connectors/custom/callback"],
      scope: "read write",
    });
    expect(provider.tokenBodies).toHaveLength(2);
    expect(provider.tokenAuthorizationHeaders).toStrictEqual([
      `Basic ${Buffer.from(
        "automatic-dcr-client:automatic-dcr-secret",
        "utf8",
      ).toString("base64")}`,
      `Basic ${Buffer.from(
        "automatic-dcr-client:automatic-dcr-secret",
        "utf8",
      ).toString("base64")}`,
    ]);
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toHaveLength(2);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it.each([
    {
      tokenEndpointAuthMethod: "none" as const,
      expectedAuthorization: null,
      expectedClientSecret: null,
    },
    {
      tokenEndpointAuthMethod: "client_secret_post" as const,
      expectedAuthorization: null,
      expectedClientSecret: "automatic-dcr-secret",
    },
  ])(
    "connects an Automatic DCR client using $tokenEndpointAuthMethod",
    async ({
      tokenEndpointAuthMethod,
      expectedAuthorization,
      expectedClientSecret,
    }) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrTokenEndpointAuthMethod: tokenEndpointAuthMethod,
      });
      const admin = createBddApi(context).user({ orgRole: "org:admin" });
      await connectorsApi.updateFeatureSwitches(admin, {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      });
      const connector = await connectorsApi.createCustomConnector(admin, {
        kind: "mcp",
        displayName: `BDD Automatic DCR ${tokenEndpointAuthMethod}`,
        endpoint: provider.endpoint,
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      });

      const authorizationUrl = await connectorsApi.startCustomConnectorOAuth2(
        admin,
        connector.id,
      );
      await connectorsApi.completeCustomConnectorOAuth2Callback({
        code: `automatic-${tokenEndpointAuthMethod}-code`,
        state: stateFromAuthorizationUrl(authorizationUrl),
        iss: provider.issuer,
      });

      expect(provider.registrationBodies).toHaveLength(1);
      expect(provider.tokenAuthorizationHeaders).toStrictEqual([
        expectedAuthorization,
      ]);
      expect(provider.tokenBodies[0]?.get("client_id")).toBe(
        "automatic-dcr-client",
      );
      expect(provider.tokenBodies[0]?.get("client_secret")).toBe(
        expectedClientSecret,
      );

      await connectorsApi.deleteCustomConnector(admin, connector.id);
    },
  );

  it("discovers Automatic OAuth through RFC 9728 and OIDC fallbacks", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      discovery: "well-known-oidc",
      challengeScope: null,
      metadataScopes: ["metadata-read", "metadata-write"],
      issuerParameterSupported: false,
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Automatic Discovery Fallback",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const authorizationUrl = new URL(
      await connectorsApi.startCustomConnectorOAuth2(admin, connector.id),
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "metadata-read metadata-write",
    );
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "automatic-discovery-fallback-code",
      state: stateFromAuthorizationUrl(authorizationUrl.toString()),
    });
    expect(provider.tokenBodies).toHaveLength(1);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it("serializes concurrent first Automatic DCR registrations", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      synchronizeAuthorizationServerDiscovery: true,
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Concurrent Automatic DCR",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const authorizationUrls = await Promise.all([
      connectorsApi.startCustomConnectorOAuth2(admin, connector.id),
      connectorsApi.startCustomConnectorOAuth2(admin, connector.id),
    ]);
    expect(authorizationUrls).toHaveLength(2);
    expect(provider.authorizationServerDiscoveryCalls()).toBe(2);
    expect(provider.registrationBodies).toHaveLength(1);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it("maps temporary Automatic OAuth discovery and DCR failures to 502", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connectorBody = {
      kind: "mcp" as const,
      displayName: "BDD Temporary Automatic OAuth",
      endpoint: "https://automatic-mcp.example.test/server",
      transport: "streamable-http" as const,
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic" as const,
    };
    const discoveryProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      resourceMetadataStatus: 503,
    });
    const discoveryConnector = await connectorsApi.createCustomConnector(
      admin,
      connectorBody,
    );
    const discoveryFailure =
      await connectorsApi.requestStartCustomConnectorOAuth2(
        admin,
        discoveryConnector.id,
        [502],
      );
    expectApiError(discoveryFailure.body);
    expect(discoveryFailure.body.error).toMatchObject({
      code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
    });
    expect(discoveryProvider.registrationBodies).toHaveLength(0);
    await connectorsApi.deleteCustomConnector(admin, discoveryConnector.id);

    for (const status of [429, 503]) {
      const dcrProvider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrFailureStatus: status,
      });
      const dcrConnector = await connectorsApi.createCustomConnector(admin, {
        ...connectorBody,
        displayName: `BDD Temporary Automatic DCR ${status}`,
      });
      const dcrFailure = await connectorsApi.requestStartCustomConnectorOAuth2(
        admin,
        dcrConnector.id,
        [502],
      );
      expectApiError(dcrFailure.body);
      expect(dcrFailure.body.error).toMatchObject({
        code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
      });
      expect(dcrProvider.registrationBodies).toHaveLength(1);
      await connectorsApi.deleteCustomConnector(admin, dcrConnector.id);
    }
  });

  it.each([
    {
      boundary: "an invalid MCP authentication response",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHENTICATION_RESPONSE_INVALID,
      providerOptions: {
        registration: "cimd" as const,
        authentication: "invalid" as const,
      },
    },
    {
      boundary: "a mismatched protected resource",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
      providerOptions: {
        registration: "cimd" as const,
        resource: "https://automatic-mcp.example.test/other-resource",
      },
    },
    {
      boundary: "an unsafe authorization endpoint",
      expectedCode: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL,
      providerOptions: {
        registration: "cimd" as const,
        authorizationEndpoint: "https://localhost/authorize",
      },
    },
    {
      boundary: "a mismatched metadata issuer",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
      providerOptions: {
        registration: "cimd" as const,
        metadataIssuer: "https://other-issuer.example.test",
      },
    },
    {
      boundary: "unsupported authorization code",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED,
      providerOptions: {
        registration: "cimd" as const,
        authorizationCodeSupported: false,
      },
    },
    {
      boundary: "unsupported PKCE",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED,
      providerOptions: {
        registration: "cimd" as const,
        pkceS256Supported: false,
      },
    },
    {
      boundary: "no automatic client registration",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_UNAVAILABLE,
      providerOptions: { registration: "none" as const },
    },
    {
      boundary: "rejected client registration",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_REJECTED,
      providerOptions: {
        registration: "dcr" as const,
        dcrFailureStatus: 400,
        dcrFailureDescription: "private-upstream-sentinel",
      },
    },
    {
      boundary: "invalid client registration details",
      expectedCode:
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_INVALID,
      providerOptions: {
        registration: "dcr" as const,
        invalidDcrResponse: true,
      },
    },
  ])(
    "rejects Automatic OAuth with $boundary",
    async ({ expectedCode, providerOptions }) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      const provider = mockAutomaticMcpOAuthProvider(context, providerOptions);
      const admin = createBddApi(context).user({ orgRole: "org:admin" });
      await connectorsApi.updateFeatureSwitches(admin, {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      });
      const connector = await connectorsApi.createCustomConnector(admin, {
        kind: "mcp",
        displayName: "BDD Rejected Automatic OAuth",
        endpoint: provider.endpoint,
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      });

      const rejected = await connectorsApi.requestStartCustomConnectorOAuth2(
        admin,
        connector.id,
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error).toStrictEqual({
        code: expectedCode,
        message:
          "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method.",
      });
      expect(rejected.body.error.message).not.toContain(
        "private-upstream-sentinel",
      );
      expect(provider.tokenBodies).toHaveLength(0);

      await connectorsApi.deleteCustomConnector(admin, connector.id);
    },
  );

  it("returns a distinct code when connected accounts hold an incompatible DCR client", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      challengeScope: "read",
    });
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectorsApi.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "BDD Automatic DCR Scope Conflict",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });

    const firstAuthorization = await connectorsApi.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "automatic-dcr-scope-conflict-code",
      state: stateFromAuthorizationUrl(firstAuthorization),
      iss: provider.issuer,
    });
    provider.setChallengeScope("read write");

    const conflict = await connectorsApi.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [400],
      undefined,
      { intent: "add" },
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.code).toBe(
      CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_CONFLICT,
    );
    expect(provider.registrationBodies).toHaveLength(1);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
  });

  it("models Automatic OAuth definitions, bindings, and state", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const definition = {
      kind: "mcp" as const,
      displayName: "BDD Automatic OAuth",
      endpoint: "https://automatic-mcp.example.test/server",
      transport: "streamable-http" as const,
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic" as const,
    };

    const createdDefinition = await connectorsApi.createCustomConnector(
      admin,
      definition,
    );
    expect(createdDefinition).toMatchObject({
      authMode: "automatic",
    });
    expect(createdDefinition).not.toHaveProperty("oauthSetup");
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: createdDefinition.id,
      }),
    ).resolves.not.toHaveProperty("definition_oauth_setup");
    await connectorsApi.deleteCustomConnector(admin, createdDefinition.id);

    const customConnectorId = randomUUID();
    const connectorAccountId = randomUUID();
    const dcrRegistrationId = randomUUID();
    const encryptedClientSecret = "encrypted-dcr-client-secret";
    const seededEndpoint = "https://mcp.example.test/";
    await seedAutomaticOAuthBindingState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      connectorAccountId,
      issuer: "https://issuer.example.test",
      resource: seededEndpoint,
      resourceMetadataUrl:
        "https://automatic-mcp.example.test/.well-known/oauth-protected-resource",
      tokenEndpoint: "https://issuer.example.test/token",
      clientId: "automatic-dcr-client",
      registration: {
        method: "dcr",
        registrationId: dcrRegistrationId,
        tokenEndpointAuthMethod: "client_secret_basic",
        encryptedClientSecret,
      },
    });

    const persisted = await connectorsApi.readCustomConnector(
      admin,
      customConnectorId,
    );
    expect(persisted).toMatchObject({
      id: customConnectorId,
      kind: "mcp",
      authMode: "automatic",
      connected: false,
    });
    expect(persisted).not.toHaveProperty("oauthConfig");
    expectNoVisibleSecret(persisted, encryptedClientSecret);
    await expect(
      readAutomaticOAuthBindingState(context, connectorAccountId),
    ).resolves.toStrictEqual({
      exists: true,
      valid: true,
      registration_method: "dcr",
      dcr_client_secret_present: true,
    });

    const cimdConnectorId = randomUUID();
    const cimdAccountId = randomUUID();
    await seedAutomaticOAuthBindingState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: cimdConnectorId,
      connectorAccountId: cimdAccountId,
      issuer: "https://cimd.example.test",
      resource: "https://cimd-mcp.example.test/server",
      resourceMetadataUrl: null,
      tokenEndpoint: "https://cimd.example.test/token",
      clientId: "https://app.okou.test/.well-known/oauth-client",
      registration: {
        method: "cimd",
        tokenEndpointAuthMethod: "none",
      },
    });
    await expect(
      readAutomaticOAuthBindingState(context, cimdAccountId),
    ).resolves.toStrictEqual({
      exists: true,
      valid: true,
      registration_method: "cimd",
    });
    await connectorsApi.deleteCustomConnector(admin, cimdConnectorId);

    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      authMethod: "none",
      storageVersion: 1,
    });
    await expect(
      readAutomaticOAuthBindingState(context, connectorAccountId),
    ).resolves.toMatchObject({ exists: true, valid: false });
    await expect(
      connectorsApi.listCustomConnectorAccounts(admin, customConnectorId),
    ).resolves.toMatchObject([
      { authMethod: "none", connectionStatus: "reconnect-required" },
    ]);
    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      authMethod: "oauth",
      storageVersion: 2,
    });
    await expect(
      readAutomaticOAuthBindingState(context, connectorAccountId),
    ).resolves.toMatchObject({ exists: true, valid: false });
    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      authMethod: "oauth",
      storageVersion: 1,
    });
    await expect(
      readAutomaticOAuthBindingState(context, connectorAccountId),
    ).resolves.toMatchObject({ exists: true, valid: true });

    const legacyState = `legacy-automatic-oauth-${randomUUID()}`;
    await seedCustomConnectorOAuthStateContext(context, {
      state: legacyState,
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      storageVersion: 1,
      redirectUri:
        "https://app.okou.test/api/custom-connectors/oauth2/callback",
      oauthContext: {
        version: 1,
        oauthSetup: "automatic",
        connectorId: customConnectorId,
        storageVersion: 1,
        issuer: "https://issuer.example.test",
        resource: seededEndpoint,
        resourceMetadataUrl:
          "https://automatic-mcp.example.test/.well-known/oauth-protected-resource",
        authorizationEndpoint: "https://issuer.example.test/authorize",
        tokenEndpoint: "https://issuer.example.test/token",
        authorizationResponseIssParameterSupported: true,
        clientId: "automatic-dcr-client",
        tokenEndpointAuthMethod: "client_secret_basic",
        registrationMethod: "dcr",
        dcrRegistrationId,
      },
    });
    await expect(
      readCustomConnectorOAuthStorageState(context, legacyState),
    ).resolves.toMatchObject({
      custom_oauth_state: {
        context_valid: false,
      },
    });
    const legacyCallback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "legacy-automatic-oauth-code",
        state: legacyState,
        iss: "https://issuer.example.test",
      });
    expect(legacyCallback.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });

    const canonicalState = `canonical-automatic-oauth-${randomUUID()}`;
    await seedCustomConnectorOAuthStateContext(context, {
      state: canonicalState,
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      storageVersion: 1,
      redirectUri:
        "https://app.okou.test/api/custom-connectors/oauth2/callback",
      oauthContext: {
        version: 2,
        authMode: "automatic",
        connectorId: customConnectorId,
        storageVersion: 1,
        issuer: "https://issuer.example.test",
        resource: seededEndpoint,
        resourceMetadataUrl:
          "https://automatic-mcp.example.test/.well-known/oauth-protected-resource",
        authorizationEndpoint: "https://issuer.example.test/authorize",
        tokenEndpoint: "https://issuer.example.test/token",
        authorizationResponseIssParameterSupported: true,
        clientId: "automatic-dcr-client",
        tokenEndpointAuthMethod: "client_secret_basic",
        registrationMethod: "dcr",
        dcrRegistrationId,
      },
    });
    await expect(
      readCustomConnectorOAuthStorageState(context, canonicalState),
    ).resolves.toMatchObject({
      custom_oauth_state: {
        context_valid: true,
        auth_mode: "automatic",
      },
    });
    const canonicalCallback =
      await connectorsApi.completeCustomConnectorOAuth2CallbackResult({
        code: "canonical-automatic-oauth-code",
        state: canonicalState,
        iss: "https://issuer.example.test",
      });
    expect(canonicalCallback.body).toStrictEqual({
      status: "error",
      message: "OAuth token exchange failed - please try again",
    });

    const malformedState = `malformed-automatic-oauth-${randomUUID()}`;
    await seedCustomConnectorOAuthStateContext(context, {
      state: malformedState,
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId,
      storageVersion: 1,
      redirectUri:
        "https://app.okou.test/api/custom-connectors/oauth2/callback",
      oauthContext: {
        version: 2,
        authMode: "automatic",
        oauthSetup: "automatic",
        connectorId: customConnectorId,
        storageVersion: 1,
        issuer: "https://issuer.example.test",
        resource: seededEndpoint,
        resourceMetadataUrl:
          "https://automatic-mcp.example.test/.well-known/oauth-protected-resource",
        authorizationEndpoint: "https://issuer.example.test/authorize",
        tokenEndpoint: "https://issuer.example.test/token",
        authorizationResponseIssParameterSupported: true,
        clientId: "automatic-dcr-client",
        tokenEndpointAuthMethod: "client_secret_basic",
        registrationMethod: "dcr",
        dcrRegistrationId,
      },
    });
    await expect(
      readCustomConnectorOAuthStorageState(context, malformedState),
    ).resolves.toMatchObject({
      custom_oauth_state: { context_valid: false },
    });

    const updated = await connectorsApi.updateCustomConnector(
      admin,
      customConnectorId,
      {
        ...definition,
        authMode: "oauth",
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{oauth.access_token}}",
          },
        ],
        oauthConfig: {
          providerAdapter: "standard",
          clientId: "static-oauth-client",
          clientSecret: "static-oauth-secret",
          authorizationUrl: "https://static-oauth.example.test/authorize",
          tokenUrl: "https://static-oauth.example.test/token",
          tokenEndpointAuthMethod: "client_secret_basic",
          pkceMethod: "S256",
          scopes: ["read"],
          authorizationParams: {},
        },
      },
    );
    expect(updated).toMatchObject({
      authMode: "oauth",
      storageVersion: 2,
      connected: false,
    });
    expect(updated).not.toHaveProperty("oauthSetup");
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId,
      }),
    ).resolves.toMatchObject({ connector: { storage_version: 1 } });
    await expect(
      readAutomaticOAuthBindingState(context, connectorAccountId),
    ).resolves.toStrictEqual({
      exists: false,
      valid: false,
      registration_method: null,
    });
    const automaticUpdate = await connectorsApi.updateCustomConnector(
      admin,
      customConnectorId,
      definition,
    );
    expect(automaticUpdate).toMatchObject({
      authMode: "automatic",
      storageVersion: 3,
    });
    await connectorsApi.deleteCustomConnector(admin, customConnectorId);

    const invalidConnectorId = randomUUID();
    const invalidAccountId = randomUUID();
    await seedAutomaticOAuthBindingState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: invalidConnectorId,
      connectorAccountId: invalidAccountId,
      issuer: "ftp://issuer.example.test",
      resource: definition.endpoint,
      resourceMetadataUrl: null,
      tokenEndpoint: "https://issuer.example.test/token",
      clientId: "invalid-dcr-client",
      registration: {
        method: "dcr",
        registrationId: randomUUID(),
        tokenEndpointAuthMethod: "none",
        encryptedClientSecret: null,
      },
    });
    await expect(
      readAutomaticOAuthBindingState(context, invalidAccountId),
    ).resolves.toStrictEqual({
      exists: true,
      valid: false,
      registration_method: "dcr",
    });
    await connectorsApi.deleteCustomConnector(admin, invalidConnectorId);
  });

  it("updates OAuth settings and preserves member OAuth data as incompatible", async () => {
    const provider = mockCustomConnectorOAuth2Provider(context);
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const clientId = "bdd-edit-oauth-client-id";
    const clientSecret = "bdd-edit-oauth-client-secret";
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Editable OAuth Connector",
      prefixTemplates: ["https://editable-oauth.example.test/v1/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId,
        clientSecret,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });

    const initialAuthorizationUrl =
      await connectorsApi.startCustomConnectorOAuth2(member, created.id);
    await connectorsApi.completeCustomConnectorOAuth2Callback({
      code: "bdd-edit-oauth-code",
      state: stateFromAuthorizationUrl(initialAuthorizationUrl),
    });
    const connected = await connectorsApi.listCustomConnectors(member);
    expect(
      connected.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: true,
    });

    const updateBody = {
      displayName: "BDD Edited OAuth Connector",
      prefixTemplates: ["https://editable-oauth.example.test/v2/"],
      fields: [],
      headerInjections: created.headerInjections,
      queryInjections: [],
      authMode: "oauth" as const,
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "none" as const,
        scopes: ["read", "write"],
        authorizationParams: {},
      },
    };
    const memberUpdate = await connectorsApi.requestUpdateCustomConnector(
      member,
      created.id,
      updateBody,
      [403],
    );
    expectApiError(memberUpdate.body);
    expect(memberUpdate.body.error.message).toContain("Only org admins");

    const updated = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      updateBody,
    );
    expect(updated).toMatchObject({
      displayName: "BDD Edited OAuth Connector",
      prefixTemplates: ["https://editable-oauth.example.test/v2/"],
      authMode: "oauth",
      storageVersion: 2,
      oauthConfig: {
        clientId,
        scopes: ["read", "write"],
      },
    });
    expectNoVisibleSecret(updated, clientSecret);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(member),
        userId: member.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({ connector: { storage_version: 1 } });

    const disconnected = await connectorsApi.listCustomConnectors(member);
    expect(
      disconnected.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: false,
      missingRequiredFields: ["oauth"],
    });

    const nextAuthorizationUrl = await connectorsApi.startCustomConnectorOAuth2(
      member,
      created.id,
    );
    const nextAuthorization = new URL(nextAuthorizationUrl);
    expect(nextAuthorization.searchParams.get("client_id")).toBe(clientId);
    expect(nextAuthorization.searchParams.get("scope")).toBe("read write");

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("rejects API definition updates for an OAuth-only connector without changing it", async () => {
    const provider = mockCustomConnectorOAuth2Provider(context);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const original = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD OAuth Only Connector",
      prefixTemplates: ["https://oauth-only.example.test/v1/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "oauth-only-client-id",
        clientSecret: "oauth-only-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });

    const rejected = await connectorsApi.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "update",
          connectorId: original.id,
          displayName: "BDD OAuth Connector With API Fields",
          prefixTemplates: ["https://oauth-only.example.test/v2/"],
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        },
        values: [
          {
            key: "api_key",
            kind: "secret",
            value: "must-not-be-stored",
          },
        ],
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain("must be variables");

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(listed).toContainEqual(original);
    expectNoVisibleSecret(listed, "must-not-be-stored");

    await connectorsApi.deleteCustomConnector(admin, original.id);
  });

  it("persists canonical manual template references unchanged on create and update", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const fields = [
      {
        key: "secret",
        label: "Connector secret",
        kind: "secret" as const,
        required: true,
      },
      {
        key: "api_key",
        label: "API key",
        kind: "secret" as const,
        required: true,
      },
      {
        key: "region",
        label: "Region",
        kind: "variable" as const,
        required: true,
      },
    ];
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Canonical Placeholder Create",
      prefixTemplates: [`https://${rand}.canonical-create.test/v1/`],
      fields,
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate:
            "Bearer {{secrets.secret}}/{{secrets.secret}}/{{secrets.api_key}}",
        },
      ],
      queryInjections: [
        {
          name: "token",
          valueTemplate: "{{secrets.secret}}:{{variables.region}}",
        },
      ],
      authMode: "manual",
    });
    const createdInjections = {
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate:
            "Bearer {{secrets.secret}}/{{secrets.secret}}/{{secrets.api_key}}",
        },
      ],
      queryInjections: [
        {
          name: "token",
          valueTemplate: "{{secrets.secret}}:{{variables.region}}",
        },
      ],
    };
    expect(created).toMatchObject(createdInjections);
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject(createdInjections);

    const updated = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: "BDD Canonical Placeholder Update",
        prefixTemplates: created.prefixTemplates,
        fields,
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Token {{secrets.secret}}/{{secrets.api_key}}",
          },
        ],
        queryInjections: [
          {
            name: "token",
            valueTemplate: "{{variables.region}}:{{secrets.secret}}",
          },
        ],
        authMode: "manual",
      },
    );
    const updatedInjections = {
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Token {{secrets.secret}}/{{secrets.api_key}}",
        },
      ],
      queryInjections: [
        {
          name: "token",
          valueTemplate: "{{variables.region}}:{{secrets.secret}}",
        },
      ],
    };
    expect(updated.storageVersion).toBe(created.storageVersion);
    expect(updated).toMatchObject(updatedInjections);
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject(updatedInjections);

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("rejects retired manual secret placeholder writes before persistence", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const fields = [
      {
        key: "secret",
        label: "Connector secret",
        kind: "secret" as const,
        required: true,
      },
    ];
    const rejectedDisplayNames: string[] = [];
    const rejectedTemplates = [
      {
        label: "header",
        headerInjections: [
          { name: "Authorization", valueTemplate: "Bearer {{secret}}" },
        ],
        queryInjections: [],
      },
      {
        label: "query",
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [{ name: "token", valueTemplate: "{{secret}}" }],
      },
      {
        label: "mixed",
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}/{{secret}}",
          },
        ],
        queryInjections: [],
      },
    ];
    for (const rejectedTemplate of rejectedTemplates) {
      const displayName = `BDD Retired Placeholder ${rejectedTemplate.label}`;
      rejectedDisplayNames.push(displayName);
      const rejected = await connectorsApi.requestCreateCustomConnector(
        admin,
        {
          displayName,
          prefixTemplates: [
            `https://${rand}.${rejectedTemplate.label}-retired.test/v1/`,
          ],
          fields,
          headerInjections: rejectedTemplate.headerInjections,
          queryInjections: rejectedTemplate.queryInjections,
          authMode: "manual",
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toContain(
        "uses unsupported template placeholder",
      );
    }

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.some((connector) => {
        return rejectedDisplayNames.includes(connector.displayName);
      }),
    ).toBeFalsy();

    const canonical = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Canonical Placeholder Before Rejected Update",
      prefixTemplates: [`https://${rand}.canonical-update.test/v1/`],
      fields,
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.secret}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    const rejectedUpdate = await connectorsApi.requestUpdateCustomConnector(
      admin,
      canonical.id,
      {
        displayName: "BDD Retired Placeholder Update",
        prefixTemplates: canonical.prefixTemplates,
        fields,
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}/{{secret}}",
          },
        ],
        queryInjections: [],
        authMode: "manual",
      },
      [400],
    );
    expectApiError(rejectedUpdate.body);
    expect(rejectedUpdate.body.error.message).toContain(
      "uses unsupported template placeholder",
    );
    await expect(
      connectorsApi.readCustomConnector(admin, canonical.id),
    ).resolves.toMatchObject({
      displayName: canonical.displayName,
      headerInjections: canonical.headerInjections,
    });

    await connectorsApi.deleteCustomConnector(admin, canonical.id);
  });

  it("creates, patches, secrets, enables for an agent, rejects cross-org ids, and deletes through APIs", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();

    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const slug = uniqueSlug("bdd-custom");
    const secretValue = "custom-connector-secret-value";

    const memberCreate = await connectorsApi.requestCreateCustomConnector(
      member,
      customConnectorBody(uniqueSlug("member-custom")),
      [403],
    );
    expectApiError(memberCreate.body);
    expect(memberCreate.body.error.code).toBe("FORBIDDEN");

    const invalidPrefix = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...customConnectorBody(uniqueSlug("bad-custom")),
        prefixTemplates: ["http://api.example.test/"],
      },
      [400],
    );
    expectApiError(invalidPrefix.body);
    expect(invalidPrefix.body.error.message).toContain("https");

    const created = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(slug),
    );
    const listAfterCreate = await connectorsApi.listCustomConnectors(admin);
    expect(
      listAfterCreate.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      slug,
      displayName: "BDD Custom Connector",
      prefixTemplates: [`https://${slug.slice(1)}.example.test/v1/`],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.secret}}",
        },
      ],
    });

    await connectorsApi.setCustomConnectorSecret(
      admin,
      created.id,
      secretValue,
    );
    const afterSecret = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterSecret.find((connector) => {
        return connector.id === created.id;
      })?.connected,
    ).toBeTruthy();
    expectNoVisibleSecret(afterSecret, secretValue);

    const definitionUpdateBody = {
      displayName: "BDD Custom Connector Updated",
      prefixTemplates: [`https://${slug.slice(1)}.example.test/v2/`],
      fields: created.fields,
      headerInjections: created.headerInjections,
      queryInjections: created.queryInjections,
      authMode: created.authMode,
    };
    const updated = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      definitionUpdateBody,
    );
    expect(updated).toMatchObject({
      displayName: "BDD Custom Connector Updated",
      prefixTemplates: [`https://${slug.slice(1)}.example.test/v2/`],
      connected: true,
    });

    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Connector Agent",
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([]);

    await connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, [
      created.id,
    ]);
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([created.id]);

    await connectorsApi.updateCustomConnector(admin, created.id, {
      ...definitionUpdateBody,
      displayName: "BDD Custom Connector Renamed",
      prefixTemplates: [`https://${slug.slice(1)}.example.test/v3/`],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([created.id]);

    const otherAdmin = bdd.user({ orgRole: "org:admin" });
    const otherConnector = await connectorsApi.createCustomConnector(
      otherAdmin,
      customConnectorBody(uniqueSlug("other-custom")),
    );
    const crossOrg = await connectorsApi.requestUpdateAgentCustomConnectors(
      admin,
      agent.agentId,
      [otherConnector.id],
      [400],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("VALIDATION_ERROR");

    await connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, []);
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([]);
    await connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, [
      created.id,
    ]);

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, created.id);
    const afterDisconnect = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterDisconnect.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: false,
      configuredFieldKeys: [],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([created.id]);

    await connectorsApi.setCustomConnectorSecret(
      admin,
      created.id,
      "reconnected-custom-connector-secret-value",
    );
    const afterReconnect = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterReconnect.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({ connected: true });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([created.id]);

    await connectorsApi.deleteCustomConnector(admin, created.id);
    const afterDelete = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterDelete.find((connector) => {
        return connector.id === created.id;
      }),
    ).toBeUndefined();

    await connectorsApi.deleteCustomConnector(otherAdmin, otherConnector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("lets an admin agent with an okou-scoped token create a manual definition that Connect can configure", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    if (!admin.orgId) {
      throw new Error("Expected an org-scoped admin");
    }
    mockClerkMembership(context, admin, "org:admin");
    const runId = randomUUID();
    const writeToken = generateOkouToken(admin.userId, runId, admin.orgId);
    const connectorsClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const body = {
      displayName: "BDD Agent Created",
      prefixTemplates: ["https://agent-created.example.test/v1/"],
      fields: [
        {
          key: "secret",
          label: "Secret",
          kind: "secret" as const,
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
      authMode: "manual" as const,
    };

    const created = await accept(
      connectorsClient.create({
        headers: { authorization: `Bearer ${writeToken}` },
        body,
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      connected: false,
      missingRequiredFields: ["secret"],
      configuredFieldKeys: [],
    });

    await connectorsApi.setCustomConnectorSecret(
      admin,
      created.body.id,
      "agent-created-secret",
    );
    const configured = await connectorsApi.listCustomConnectors(admin);
    expect(
      configured.find((connector) => {
        return connector.id === created.body.id;
      }),
    ).toMatchObject({
      connected: true,
      configuredFieldKeys: ["secret"],
    });
    expectNoVisibleSecret(configured, "agent-created-secret");
    const storage = await readCustomConnectorCredentialStorageParent(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: created.body.id,
    });
    expect(storage.secrets).toStrictEqual([
      {
        name: "secret",
        connector_id: storage.connector?.id,
        encrypted_value: expect.any(String),
        description: null,
      },
    ]);

    await connectorsApi.deleteCustomConnector(admin, created.body.id);
  });

  it("sets all manual custom connector values through the values endpoint", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const kms = useSecretKmsProbe();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Configured API",
      prefixTemplates: [
        `https://{{variables.subdomain}}.${rand}.example.test/v1/`,
      ],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "subdomain",
          label: "Subdomain",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    expect(created.storageVersion).toBe(1);

    const configured = await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [
        { key: "api_key", kind: "secret", value: "configured-secret" },
        { key: "subdomain", kind: "variable", value: "acme" },
      ],
    );

    expect(configured).toMatchObject({
      id: created.id,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    expect(kms.generateDataKeyCalls).toBe(1);
    expectNoVisibleSecret(configured, "configured-secret");

    const parent = await readCustomConnectorCredentialStorageParent(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: created.id,
    });
    expect(parent.connector).toMatchObject({ storage_version: 1 });
    if (!parent.connector) {
      throw new Error("Expected a Custom connector credential parent");
    }
    expect(parent.secrets).toStrictEqual([
      {
        name: "api_key",
        connector_id: parent.connector.id,
        encrypted_value: expect.any(String),
        description: null,
      },
    ]);
    expect(parent.variables).toStrictEqual([
      {
        name: "subdomain",
        connector_id: parent.connector.id,
        value: "acme",
      },
    ]);

    await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [{ key: "api_key", kind: "secret", value: "updated-secret" }],
      { intent: "reconnect", connectionId: parent.connector.id },
    );
    const updatedParent = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      },
    );
    expect(updatedParent.connector).toStrictEqual(parent.connector);
    expect(updatedParent.variables).toStrictEqual(parent.variables);
    expect(updatedParent.secrets?.[0]?.encrypted_value).not.toBe(
      parent.secrets?.[0]?.encrypted_value,
    );
    expect(kms.generateDataKeyCalls).toBe(2);

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    expectNoVisibleSecret(listed, "configured-secret");

    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: created.id,
      authMethod: "manual",
      storageVersion: 2,
    });
    const storageVersionMismatch =
      await connectorsApi.listCustomConnectors(admin);
    expect(
      storageVersionMismatch.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "subdomain"],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "subdomain"],
    });
    await setCustomConnectorCredentialStorageState(context, {
      orgId: requiredOrgId(admin),
      userId: admin.userId,
      customConnectorId: created.id,
      authMethod: "manual",
      storageVersion: 1,
    });

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, created.id);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({
      connector: null,
      secrets: [],
      variables: [],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "subdomain"],
    });

    await connectorsApi.setCustomConnectorValues(admin, created.id, [
      { key: "api_key", kind: "secret", value: "reconnected-secret" },
      { key: "subdomain", kind: "variable", value: "reconnected" },
    ]);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({
      connector: { storage_version: 1 },
      secrets: [{ name: "api_key" }],
      variables: [{ name: "subdomain", value: "reconnected" }],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "subdomain"],
      missingRequiredFields: [],
    });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("fails closed when shared custom connector values are missing", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const orgId = requiredOrgId(admin);
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Shared Credential Markers",
      prefixTemplates: [
        "https://{{variables.subdomain}}.shared-markers.example.test/v1/",
      ],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "subdomain",
          label: "Subdomain",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    const values = [
      { key: "api_key", kind: "secret" as const, value: "shared-secret" },
      { key: "subdomain", kind: "variable" as const, value: "shared" },
    ];
    await connectorsApi.setCustomConnectorValues(admin, created.id, values);

    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "subdomain"],
      missingRequiredFields: [],
    });
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId,
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({
      secrets: [{ name: "api_key" }],
      variables: [{ name: "subdomain", value: "shared" }],
    });

    await deleteCustomConnectorCredentialValues(context, {
      orgId,
      userId: admin.userId,
      customConnectorId: created.id,
    });
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId,
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({
      secrets: [],
      variables: [],
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "subdomain"],
    });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("rejects an incomplete first manual value write without storing credentials", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Incomplete First Write",
      prefixTemplates: ["https://incomplete-first-write.example.test/v1/"],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "account",
          label: "Account",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });

    const rejected = await connectorsApi.requestSetCustomConnectorValues(
      admin,
      created.id,
      [{ key: "api_key", kind: "secret", value: "incomplete-secret" }],
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain(
      "All required fields must be provided when connecting or restoring",
    );
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({
      connector: null,
      secrets: [],
      variables: [],
    });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("isolates identical manual variable names by Custom connection", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const definition = {
      fields: [
        {
          key: "region",
          label: "Region",
          kind: "variable" as const,
          required: true,
        },
      ],
      headerInjections: [],
      queryInjections: [
        { name: "region", valueTemplate: "{{variables.region}}" },
      ],
      authMode: "manual" as const,
    };
    const first = await connectorsApi.createCustomConnector(admin, {
      ...definition,
      displayName: "BDD Variable Isolation One",
      prefixTemplates: ["https://variable-isolation-one.example.test/v1/"],
    });
    const second = await connectorsApi.createCustomConnector(admin, {
      ...definition,
      displayName: "BDD Variable Isolation Two",
      prefixTemplates: ["https://variable-isolation-two.example.test/v1/"],
    });

    await connectorsApi.setCustomConnectorValues(admin, first.id, [
      { key: "region", kind: "variable", value: "east" },
    ]);
    await connectorsApi.setCustomConnectorValues(admin, second.id, [
      { key: "region", kind: "variable", value: "west" },
    ]);
    const firstState = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: first.id,
      },
    );
    const secondState = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: second.id,
      },
    );
    expect(firstState.variables).toStrictEqual([
      {
        name: "region",
        connector_id: firstState.connector?.id,
        value: "east",
      },
    ]);
    expect(secondState.variables).toStrictEqual([
      {
        name: "region",
        connector_id: secondState.connector?.id,
        value: "west",
      },
    ]);
    expect(firstState.connector?.id).not.toBe(secondState.connector?.id);

    await connectorsApi.deleteCustomConnector(admin, first.id);
    await connectorsApi.deleteCustomConnector(admin, second.id);
  });

  it("rolls back Custom values when a shared write fails", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const created = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Custom Value Rollback",
      prefixTemplates: ["https://custom-value-rollback.example.test/v1/"],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "note",
          label: "Note",
          kind: "variable",
          required: false,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    await connectorsApi.setCustomConnectorValues(admin, created.id, [
      { key: "api_key", kind: "secret", value: "rollback-original" },
    ]);
    const storageBeforeFailure =
      await readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      });

    const failed = await connectorsApi.requestSetCustomConnectorValues(
      admin,
      created.id,
      [
        { key: "api_key", kind: "secret", value: "rollback-replacement" },
        { key: "note", kind: "variable", value: "invalid\u0000value" },
      ],
      [500],
      storageBeforeFailure.connector
        ? {
            intent: "reconnect",
            connectionId: storageBeforeFailure.connector.id,
          }
        : { intent: "add" },
    );
    expect(failed.status).toBe(500);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toStrictEqual(storageBeforeFailure);

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("authors storage versions and requires complete stale manual recovery", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const initialDefinition = {
      displayName: "BDD Versioned Manual API",
      prefixTemplates: [`https://${rand}.versioned.test/v1/`],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret" as const,
          required: true,
        },
        {
          key: "legacy_optional",
          label: "Legacy optional",
          kind: "variable" as const,
          required: false,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual" as const,
    };
    const created = await connectorsApi.createCustomConnector(admin, {
      ...initialDefinition,
      storageVersion: 3,
    });
    expect(created.storageVersion).toBe(3);
    await connectorsApi.setCustomConnectorValues(admin, created.id, [
      { key: "api_key", kind: "secret", value: "version-three-secret" },
      {
        key: "legacy_optional",
        kind: "variable",
        value: "legacy-value",
      },
    ]);
    const [initialAccount] = await connectorsApi.listCustomConnectorAccounts(
      admin,
      created.id,
    );
    if (!initialAccount) {
      throw new Error("Expected the versioned custom connector account");
    }

    const compatible = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        ...initialDefinition,
        displayName: "BDD Versioned Manual API Renamed",
        storageVersion: 3,
      },
    );
    expect(compatible.storageVersion).toBe(3);

    const changedDefinition = {
      ...initialDefinition,
      displayName: "BDD Versioned Manual API Contract 4",
      fields: [
        initialDefinition.fields[0]!,
        {
          key: "replacement",
          label: "Replacement",
          kind: "secret" as const,
          required: true,
        },
      ],
    };
    const unchangedVersion = await connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      { ...changedDefinition, storageVersion: 3 },
      [400],
    );
    expectApiError(unchangedVersion.body);
    expect(unchangedVersion.body.error.message).toContain(
      "must increase when the credential contract changes",
    );

    const inferred = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      changedDefinition,
    );
    expect(inferred.storageVersion).toBe(4);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({ connector: { storage_version: 3 } });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "replacement"],
    });

    const partialRecovery = await connectorsApi.requestSetCustomConnectorValues(
      admin,
      created.id,
      [{ key: "replacement", kind: "secret", value: "partial-replacement" }],
      [400],
      { intent: "reconnect", connectionId: initialAccount.id },
    );
    expectApiError(partialRecovery.body);
    expect(partialRecovery.body.error.message).toContain(
      "All required fields must be provided",
    );

    const recovered = await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [
        { key: "api_key", kind: "secret", value: "version-four-secret" },
        {
          key: "replacement",
          kind: "secret",
          value: "replacement-secret",
        },
      ],
      { intent: "reconnect", connectionId: initialAccount.id },
    );
    expect(recovered).toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "replacement"],
      missingRequiredFields: [],
    });
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      }),
    ).resolves.toMatchObject({ connector: { storage_version: 4 } });
    const replacementStorage = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: created.id,
      },
    );
    expect(
      replacementStorage.secrets?.map(({ name }) => {
        return name;
      }),
    ).toStrictEqual(["api_key", "replacement"]);
    expect(replacementStorage.variables).toStrictEqual([]);

    const semanticAdvance = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      { ...changedDefinition, storageVersion: 5 },
    );
    expect(semanticAdvance.storageVersion).toBe(5);
    const decrease = await connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      { ...changedDefinition, storageVersion: 4 },
      [400],
    );
    expectApiError(decrease.body);
    expect(decrease.body.error.message).toContain("cannot decrease");

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("saves a connector proposal with values and authorizes the requested agent", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Proposal Agent",
    });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    mockAuthoritativeOrganizationMembers([admin, member]);
    clearConnectorInvalidationMocks();

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Proposal API",
        prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [
          {
            name: "tenant",
            valueTemplate: "{{variables.subdomain}}",
          },
        ],
      },
      values: [
        { key: "api_key", kind: "secret", value: "proposal-secret" },
        { key: "subdomain", kind: "variable", value: "acme" },
      ],
      agentId: agent.agentId,
    });

    expectCustomConnectorInvalidations([
      admin.userId,
      member.userId,
      admin.userId,
    ]);
    expect(saved.authorizedAgentId).toBe(agent.agentId);
    expect(saved.connector).toMatchObject({
      displayName: "BDD Proposal API",
      prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([saved.connector.id]);

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.find((connector) => {
        return connector.id === saved.connector.id;
      }),
    ).toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    expectNoVisibleSecret(listed, "proposal-secret");

    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("preserves selected permissions when a proposal reauthorizes an existing connector", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Permissioned Proposal Agent",
    });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const connector = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Permissioned Proposal API",
      prefixTemplates: [`https://${rand}.permissioned-proposal.test/v1/`],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
      permissionBundleRef: "builtin:slack@1",
    });
    const grant = {
      customConnectorId: connector.id,
      permissionNames: ["chat:write"],
    };
    await connectorsApi.requestUpdateAgentCustomConnectorGrants(
      admin,
      agent.agentId,
      [grant],
      [200],
    );

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "update",
        connectorId: connector.id,
        displayName: connector.displayName,
        prefixTemplates: connector.prefixTemplates,
        fields: connector.fields,
        headerInjections: connector.headerInjections,
        queryInjections: connector.queryInjections,
      },
      values: [{ key: "api_key", kind: "secret", value: "proposal-secret" }],
      agentId: agent.agentId,
    });

    expect(saved.authorizedAgentId).toBe(agent.agentId);
    await expect(
      connectorsApi.readAgentCustomConnectorGrants(admin, agent.agentId),
    ).resolves.toStrictEqual([grant]);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("authorizes a connector proposal before required values are configured", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Missing Proposal Value Agent",
    });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Missing Proposal Value API",
        prefixTemplates: [`https://${rand}.example.test/v1/`],
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      },
      values: [],
      agentId: agent.agentId,
    });

    expect(saved.authorizedAgentId).toBe(agent.agentId);
    expect(saved.connector).toMatchObject({
      connected: false,
      missingRequiredFields: ["api_key"],
      configuredFieldKeys: [],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([saved.connector.id]);

    const emptyComplete = await connectorsApi.saveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "create",
          displayName: "BDD Optional Proposal Value API",
          prefixTemplates: [`https://optional-${rand}.example.test/v1/`],
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: false,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        },
        values: [],
        agentId: agent.agentId,
      },
    );
    expect(emptyComplete.connector).toMatchObject({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: [],
    });
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requiredOrgId(admin),
        userId: admin.userId,
        customConnectorId: emptyComplete.connector.id,
      }),
    ).resolves.toMatchObject({
      connector: { storage_version: 1 },
      secrets: [],
      variables: [],
    });

    await connectorsApi.deleteCustomConnector(
      admin,
      emptyComplete.connector.id,
    );
    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("rejects connector proposal host variables that change URL structure", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const rejected = await connectorsApi.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "create",
          displayName: "BDD Unsafe Proposal API",
          prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
            {
              key: "subdomain",
              label: "Subdomain",
              kind: "variable",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        },
        values: [
          { key: "api_key", kind: "secret", value: "unsafe-secret" },
          { key: "subdomain", kind: "variable", value: "evil.test/path" },
        ],
      },
      [400],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain(
      "not safe in custom connector host templates",
    );
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("rejects runtime-dependent custom connector hostnames at API boundaries", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    for (const host of ["\u088f.example", "xn--7xb.example"]) {
      const definition = await connectorsApi.requestCreateCustomConnector(
        admin,
        {
          ...customConnectorBody(uniqueSlug("invalid-hostname")),
          prefixTemplates: [`https://${host}/v1/`],
        },
        [400],
      );
      expectApiError(definition.body);
      expect(definition.body.error.message).toContain("vm0-uts46-16.0-v1");

      const proposal = await connectorsApi.requestSaveCustomConnectorProposal(
        admin,
        {
          proposal: {
            operation: "create",
            displayName: "BDD Invalid Hostname API",
            prefixTemplates: [
              `https://{{variables.subdomain}}.${rand}.test/v1/`,
            ],
            fields: [
              {
                key: "api_key",
                label: "API key",
                kind: "secret",
                required: true,
              },
              {
                key: "subdomain",
                label: "Subdomain",
                kind: "variable",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.api_key}}",
              },
            ],
            queryInjections: [],
          },
          values: [
            { key: "api_key", kind: "secret", value: "invalid-host-secret" },
            { key: "subdomain", kind: "variable", value: host },
          ],
        },
        [400],
      );
      expectApiError(proposal.body);
      expect(proposal.body.error.message).toContain(
        "not a valid custom connector hostname",
      );
      expectNoVisibleSecret(proposal.body, "invalid-host-secret");
    }

    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("preserves valid Unicode prefixes while deriving a canonical default slug", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rawPrefix = "https://münich.example/v1/";

    const connector = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Unicode Host API",
        prefixTemplates: [rawPrefix],
      }),
    );

    expect(connector.prefixTemplates).toStrictEqual([rawPrefix]);
    expect(connector.slug).toMatch(/^_xn-mnich-kva-example-[a-z0-9]{6}$/);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("rejects invalid hostname updates without changing the connector", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const original = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(uniqueSlug("hostname-update")),
    );

    const rejected = await connectorsApi.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "update",
          connectorId: original.id,
          displayName: "BDD Invalid Hostname Update",
          prefixTemplates: ["https://\u088f.example/v2/"],
          fields: original.fields,
          headerInjections: original.headerInjections,
          queryInjections: original.queryInjections,
        },
        values: [],
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain("vm0-uts46-16.0-v1");

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(listed).toContainEqual(original);

    await connectorsApi.deleteCustomConnector(admin, original.id);
  });

  it("disconnects a variable-only connection through the stable endpoint", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Variable-only Disconnect API",
        prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
        fields: [
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [],
        queryInjections: [
          {
            name: "tenant",
            valueTemplate: "{{variables.subdomain}}",
          },
        ],
      },
      values: [{ key: "subdomain", kind: "variable", value: "acme" }],
    });
    expect(saved.connector).toMatchObject({
      connected: true,
      configuredFieldKeys: ["subdomain"],
      headerInjections: [],
      queryInjections: [
        {
          name: "tenant",
          valueTemplate: "{{variables.subdomain}}",
        },
      ],
    });

    await connectorsApi.deleteDefaultCustomConnectorAccount(
      admin,
      saved.connector.id,
    );

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.find((connector) => {
        return connector.id === saved.connector.id;
      }),
    ).toMatchObject({
      connected: false,
      configuredFieldKeys: [],
      missingRequiredFields: ["subdomain"],
    });

    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
  });

  it("preserves authentication boundaries across custom connector routes", async () => {
    const bdd = createBddApi(context);
    const noOrgActor = bdd.user({ orgId: null });
    const connectorId = randomUUID();

    for (const actor of [null, noOrgActor]) {
      const list = await connectorsApi.requestListCustomConnectors(
        actor,
        [401],
      );
      expectApiError(list.body);
      expect(list.body.error.code).toBe("UNAUTHORIZED");

      const create = await connectorsApi.requestCreateCustomConnector(
        actor,
        customConnectorBody(uniqueSlug("noauth-custom")),
        [401],
      );
      expectApiError(create.body);
      expect(create.body.error.code).toBe("UNAUTHORIZED");

      const remove = await connectorsApi.requestDeleteCustomConnector(
        actor,
        connectorId,
        [401],
      );
      expectApiError(remove.body);
      expect(remove.body.error.code).toBe("UNAUTHORIZED");

      const secretSet = await connectorsApi.requestSetCustomConnectorSecret(
        actor,
        connectorId,
        "unauthorized-secret-value",
        [401],
      );
      expectApiError(secretSet.body);
      expect(secretSet.body.error.code).toBe("UNAUTHORIZED");

      const oauthStart = await connectorsApi.requestStartCustomConnectorOAuth2(
        actor,
        connectorId,
        [401],
      );
      expectApiError(oauthStart.body);
      expect(oauthStart.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("invalidates every organization member for definitions and only the owner for credentials", async () => {
    expect.hasAssertions();
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const slug = uniqueSlug("bdd-invalidation-audience");
    mockAuthoritativeOrganizationMembers([admin, member]);

    clearConnectorInvalidationMocks();
    const created = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(slug),
    );
    expectCustomConnectorInvalidations([admin.userId, member.userId]);

    clearConnectorInvalidationMocks();
    await connectorsApi.setCustomConnectorValues(admin, created.id, [
      { key: "secret", kind: "secret", value: "values-endpoint-secret" },
    ]);
    expectCustomConnectorInvalidations([admin.userId]);

    clearConnectorInvalidationMocks();
    await connectorsApi.updateCustomConnector(admin, created.id, {
      displayName: "BDD Invalidation Audience Updated",
      prefixTemplates: [`https://${slug.slice(1)}.example.test/v2/`],
      fields: created.fields,
      headerInjections: created.headerInjections,
      queryInjections: created.queryInjections,
      authMode: created.authMode,
    });
    expectCustomConnectorInvalidations([admin.userId, member.userId]);

    clearConnectorInvalidationMocks();
    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, created.id);
    expectCustomConnectorInvalidations([admin.userId]);

    clearConnectorInvalidationMocks();
    await connectorsApi.deleteCustomConnector(admin, created.id);
    expectCustomConnectorInvalidations([admin.userId, member.userId]);
  });

  it("validates and normalises custom connector creation through visible create and list responses", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const host = `bdd${rand}.example.test`;

    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);

    mockAuthoritativeOrganizationMembers([admin]);

    const autoSlug = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Auto Slug",
        prefixTemplates: [`https://api.${host}/v1`],
      }),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "customConnectorListChanged",
      null,
    );
    expect(autoSlug.slug).toMatch(
      new RegExp(`^_api-bdd${rand}-example-test-[a-z0-9]{6}$`),
    );
    expect(autoSlug.prefixTemplates).toStrictEqual([`https://api.${host}/v1/`]);
    expect(autoSlug.connected).toBeFalsy();

    const duplicateAutoSlug = await connectorsApi.requestCreateCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Duplicate Auto Slug",
        prefixTemplates: [`https://api.${host}/v1`],
      }),
      [400],
    );
    expectApiError(duplicateAutoSlug.body);
    expect(duplicateAutoSlug.body.error.message).toContain(
      `"${autoSlug.displayName}"`,
    );

    const wildcard = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Wildcard",
        prefixTemplates: [`https://*.${host}/v1`],
      }),
    );
    expect(wildcard.slug).toMatch(
      new RegExp(`^_bdd${rand}-example-test-[a-z0-9]{6}$`),
    );
    expect(wildcard.prefixTemplates).toStrictEqual([`https://*.${host}/v1/`]);

    const missingPlaceholder = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...manualHttpCustomConnectorCreateBody({
          displayName: "BDD Bad Template",
          prefixTemplates: [`https://template.${host}/`],
        }),
        headerInjections: [
          { name: "Authorization", valueTemplate: "Bearer static-token" },
        ],
      },
      [400],
    );
    expectApiError(missingPlaceholder.body);
    expect(missingPlaceholder.body.error.message).toContain(
      "must reference a declared secret or variable field",
    );

    const builtinOverlap = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "Custom GitHub",
        prefixTemplates: ["https://api.github.com/v3/"],
      }),
    );
    expect(builtinOverlap.prefixTemplates).toStrictEqual([
      "https://api.github.com/v3/",
    ]);

    const builtinTrailingDotOverlap =
      await connectorsApi.requestCreateCustomConnector(
        admin,
        manualHttpCustomConnectorCreateBody({
          displayName: "Custom GitHub Trailing Dot",
          prefixTemplates: ["https://api.github.com./v3/"],
        }),
        [400],
      );
    expectApiError(builtinTrailingDotOverlap.body);
    expect(builtinTrailingDotOverlap.body.error.message).toContain(
      `"${builtinOverlap.displayName}"`,
    );

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed
        .map((connector) => {
          return connector.id;
        })
        .sort(),
    ).toStrictEqual([autoSlug.id, wildcard.id, builtinOverlap.id].sort());

    await connectorsApi.deleteCustomConnector(admin, autoSlug.id);
    await connectorsApi.deleteCustomConnector(admin, wildcard.id);
    await connectorsApi.deleteCustomConnector(admin, builtinOverlap.id);
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("manages MCP definitions and keeps feature-off operations access-reducing", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const initialDefinition = manualMcpConnectorBody({
      displayName: "BDD MCP Management",
      endpoint: "https://mcp-management.example.test/server",
    });
    const disabledCreate = await connectorsApi.requestCreateCustomConnector(
      admin,
      initialDefinition,
      [403],
    );
    expectApiError(disabledCreate.body);
    expect(disabledCreate.body.error.code).toBe("FORBIDDEN");

    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const rejectedPublicMcp = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        kind: "mcp",
        displayName: "BDD Public MCP",
        endpoint: "https://public-mcp.example.test/server",
        transport: "streamable-http",
        fields: [],
        headerInjections: [
          { name: "X-Public-Mode", valueTemplate: "readonly" },
        ],
        queryInjections: [],
        authMode: "manual",
      },
      [400],
    );
    expectApiError(rejectedPublicMcp.body);
    expect(rejectedPublicMcp.body.error.message).toBe(
      "Manual custom connector injections must reference a declared secret or variable field",
    );

    const agent = await bdd.createAgent(admin, {
      displayName: "BDD MCP Management Agent",
    });
    const created = await connectorsApi.createCustomConnector(
      admin,
      initialDefinition,
    );
    expect(created).toMatchObject({
      kind: "mcp",
      displayName: "BDD MCP Management",
      endpoint: "https://mcp-management.example.test/server",
      transport: "streamable-http",
      prefixTemplates: [],
      permissionBundleRef: null,
      storageVersion: 1,
      connected: false,
    });

    const connected = await connectorsApi.setCustomConnectorValues(
      admin,
      created.id,
      [{ key: "secret", kind: "secret", value: "bdd-mcp-api-token" }],
    );
    expect(connected).toMatchObject({ connected: true });
    expectNoVisibleSecret(connected, "bdd-mcp-api-token");
    await expect(
      connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, [
        created.id,
      ]),
    ).resolves.toContain(created.id);

    const movedDefinition = manualMcpConnectorBody({
      displayName: "BDD MCP Management Moved",
      endpoint: "https://mcp-management.example.test/v2/server",
    });
    const moved = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      movedDefinition,
    );
    expect(moved).toMatchObject({
      id: created.id,
      endpoint: movedDefinition.endpoint,
      storageVersion: 1,
      connected: true,
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toContain(created.id);

    const protocolTransition = await connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        displayName: "HTTP Rewrite",
        prefixTemplates: ["https://api.example.test/"],
        fields: initialDefinition.fields,
        headerInjections: initialDefinition.headerInjections,
        queryInjections: [],
        authMode: "manual",
      },
      [400],
    );
    expectApiError(protocolTransition.body);
    expect(protocolTransition.body.error.message).toBe(
      "Custom connector protocol kind cannot be changed",
    );

    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: false,
    });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      kind: "mcp",
      endpoint: movedDefinition.endpoint,
    });
    const renamed = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        ...movedDefinition,
        displayName: "BDD MCP Renamed While Disabled",
      },
    );
    expect(renamed).toMatchObject({
      displayName: "BDD MCP Renamed While Disabled",
      endpoint: movedDefinition.endpoint,
      storageVersion: 1,
    });

    const blockedDefinition = await connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        ...movedDefinition,
        endpoint: "https://mcp-management.example.test/v3/server",
      },
      [403],
    );
    expectApiError(blockedDefinition.body);
    expect(blockedDefinition.body.error.code).toBe("FORBIDDEN");

    const valueWrite = await connectorsApi.requestSetCustomConnectorValues(
      admin,
      created.id,
      [{ key: "secret", kind: "secret", value: "replacement" }],
      [403],
    );
    expectApiError(valueWrite.body);
    expect(valueWrite.body.error.code).toBe("FORBIDDEN");

    await expect(
      connectorsApi.updateAgentCustomConnectors(
        admin,
        agent.agentId,
        [created.id],
        "remove",
      ),
    ).resolves.not.toContain(created.id);
    const blockedGrant = await connectorsApi.requestUpdateAgentCustomConnectors(
      admin,
      agent.agentId,
      [created.id],
      [403],
      "add",
    );
    expectApiError(blockedGrant.body);
    expect(blockedGrant.body.error.code).toBe("FORBIDDEN");

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, created.id);
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ connected: false });
    await connectorsApi.deleteCustomConnector(admin, created.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("rejects unsafe MCP endpoints and protected transport headers", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    await connectorsApi.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });

    const hybrid = await connectorsApi.requestCreateCustomConnectorRaw(admin, {
      ...manualMcpConnectorBody({
        displayName: "Hybrid MCP",
        endpoint: "https://hybrid-mcp.example.test/server",
      }),
      prefixTemplates: ["https://api.example.test/"],
    });
    expect(hybrid.status).toBe(400);
    await expect(hybrid.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    for (const endpoint of [
      "http://mcp.example.test/server",
      "https://user@mcp.example.test/server",
      "https://mcp.example.test/server?token=value",
      "https://mcp.example.test/server#fragment",
      "https://{{variables.host}}/server",
      "https://127.0.0.1/server",
      "https://[::1]/server",
      "https://mcp.example.test:443:444/server",
    ]) {
      const response = await connectorsApi.requestCreateCustomConnector(
        admin,
        manualMcpConnectorBody({
          displayName: `Invalid MCP ${endpoint}`,
          endpoint,
        }),
        [400],
      );
      expectApiError(response.body);
    }

    for (const name of [
      "Host",
      "Content-Type",
      "Last-Event-ID",
      "MCP-Protocol-Version",
      "X-Okou-Connector-Intent",
      "X-VM0-Connector-Intent",
    ]) {
      const definition = manualMcpConnectorBody({
        displayName: `Protected ${name}`,
        endpoint: "https://protected-mcp.example.test/server",
      });
      const response = await connectorsApi.requestCreateCustomConnector(
        admin,
        {
          ...definition,
          headerInjections: [
            {
              name,
              valueTemplate: "Bearer {{secrets.secret}}",
            },
          ],
        },
        [400],
      );
      expectApiError(response.body);
      expect(response.body.error.message).toContain("protected header");
    }

    const sharedEndpoint = "https://shared-mcp.example.test/server";
    const first = await connectorsApi.createCustomConnector(
      admin,
      manualMcpConnectorBody({
        displayName: "Shared MCP One",
        endpoint: sharedEndpoint,
      }),
    );
    const second = await connectorsApi.createCustomConnector(
      admin,
      manualMcpConnectorBody({
        displayName: "Shared MCP Two",
        endpoint: sharedEndpoint,
      }),
    );
    expect(first).toMatchObject({ kind: "mcp", endpoint: sharedEndpoint });
    expect(second).toMatchObject({ kind: "mcp", endpoint: sharedEndpoint });

    const rootEndpoint = "https://root-mcp.example.test";
    const root = await connectorsApi.createCustomConnector(
      admin,
      manualMcpConnectorBody({
        displayName: "Root MCP",
        endpoint: rootEndpoint,
      }),
    );
    expect(root).toMatchObject({ kind: "mcp", endpoint: rootEndpoint });
    expect(root.slug).toMatch(/^_root-mcp-example-test-[a-f0-9]{6}$/u);

    const http = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD HTTP Transition Source",
        prefixTemplates: ["https://http-transition.example.test/"],
      }),
    );
    const transition = await connectorsApi.requestUpdateCustomConnector(
      admin,
      http.id,
      manualMcpConnectorBody({
        displayName: "MCP Transition Target",
        endpoint: sharedEndpoint,
      }),
      [400],
    );
    expectApiError(transition.body);
    expect(transition.body.error.message).toBe(
      "Custom connector protocol kind cannot be changed",
    );

    await connectorsApi.deleteCustomConnector(admin, first.id);
    await connectorsApi.deleteCustomConnector(admin, second.id);
    await connectorsApi.deleteCustomConnector(admin, root.id);
    await connectorsApi.deleteCustomConnector(admin, http.id);
  });

  it("keeps a created custom connector when realtime publishing fails", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    mockAuthoritativeOrganizationMembers([admin]);
    clearConnectorInvalidationMocks();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("Ably channel rate limit exceeded"),
    );

    const created = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Realtime Failure",
        prefixTemplates: [`https://realtime-${rand}.example.test/v1/`],
      }),
    );
    expectCustomConnectorInvalidations([admin.userId]);

    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          displayName: "BDD Realtime Failure",
        }),
      ]),
    );

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("keeps a created custom connector when organization membership discovery fails", async () => {
    const admin = createBddApi(context).user();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
      new Error("Clerk membership lookup unavailable"),
    );
    clearConnectorInvalidationMocks();

    const created = await connectorsApi.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Membership Failure",
        prefixTemplates: [`https://membership-${rand}.example.test/v1/`],
      }),
    );

    expect(context.mocks.ably.channelGet).not.toHaveBeenCalled();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          displayName: "BDD Membership Failure",
        }),
      ]),
    );

    mockAuthoritativeOrganizationMembers([admin]);
    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("attempts invalidation before surfacing a post-commit request abort", async () => {
    const admin = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("custom connector request cancelled");
    abortError.name = "AbortError";
    let committedConnectorId: string | undefined;

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      async () => {
        const listed = await connectorsApi.listCustomConnectors(admin);
        const committed = listed.find((connector) => {
          return connector.displayName === "BDD Post-Commit Abort";
        });
        if (!committed) {
          throw new Error(
            "Expected the custom connector definition to be committed before membership discovery",
          );
        }
        committedConnectorId = committed.id;
        controller.abort(abortError);
        return {
          data: [{ publicUserData: { userId: admin.userId } }],
        };
      },
    );
    clearConnectorInvalidationMocks();

    const response = await connectorsApi.requestCreateCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "BDD Post-Commit Abort",
        prefixTemplates: ["https://post-commit-abort.example.test/v1/"],
      }),
      [500],
      controller.signal,
    );

    expect(response.status).toBe(500);
    expectCustomConnectorInvalidations([admin.userId]);
    expect(committedConnectorId).toBeDefined();
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: committedConnectorId }),
      ]),
    );

    mockAuthoritativeOrganizationMembers([admin]);
    if (!committedConnectorId) {
      throw new Error("Expected committed connector id");
    }
    await connectorsApi.deleteCustomConnector(admin, committedConnectorId);
  });

  it("does not activate a custom connector when skill publication fails", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const slug = uniqueSlug("bdd-skill-create-failure");
    context.mocks.s3.send.mockRejectedValue(
      new Error("Custom connector skill upload failed"),
    );

    const response = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...customConnectorBody(slug),
        skillMarkdown: "This skill must never become active.",
      },
      [500],
    );

    expect(response.status).toBe(500);
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.not.toStrictEqual(
      expect.arrayContaining([expect.objectContaining({ slug })]),
    );
  });

  it("keeps the active definition and skill HEAD when an update upload fails", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    const created = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-skill-update-failure")),
      skillMarkdown: "Keep these active instructions.",
    });
    const storageName = getCustomConnectorSkillStorageName(created.id);
    const initialHead = await storagesApi.downloadStorage(admin, {
      name: storageName,
      owner: "organization",
    });
    context.mocks.s3.send.mockRejectedValue(
      new Error("Custom connector skill update upload failed"),
    );

    const response = await connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        displayName: "Must Not Become Active",
        prefixTemplates: created.prefixTemplates,
        fields: created.fields,
        headerInjections: created.headerInjections,
        queryInjections: created.queryInjections,
        authMode: created.authMode,
        skillMarkdown: "These failed instructions must not become active.",
      },
      [500],
    );

    expect(response.status).toBe(500);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      displayName: created.displayName,
      skillMarkdown: "Keep these active instructions.",
    });
    await expect(
      storagesApi.downloadStorage(admin, {
        name: storageName,
        owner: "organization",
      }),
    ).resolves.toMatchObject({ versionId: initialHead.versionId });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("does not let a stale skill update move the winning definition or HEAD", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    const created = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-skill-update-race")),
      skillMarkdown: "Initial active instructions.",
    });
    const storageName = getCustomConnectorSkillStorageName(created.id);
    const initialHead = await storagesApi.downloadStorage(admin, {
      name: storageName,
      owner: "organization",
    });
    const staleUploadStarted = createDeferredPromise<void>(context.signal);
    const releaseStaleUpload = createDeferredPromise<void>(context.signal);
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const skill = uploadedSkillInstruction(command);
      if (skill?.includes("Stale writer instructions")) {
        if (!staleUploadStarted.settled()) {
          staleUploadStarted.resolve();
        }
        await releaseStaleUpload.promise;
      }
      return { ContentLength: 1024 };
    });

    const staleRequest = connectorsApi.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        displayName: "Stale Writer",
        prefixTemplates: created.prefixTemplates,
        fields: created.fields,
        headerInjections: created.headerInjections,
        queryInjections: created.queryInjections,
        authMode: created.authMode,
        skillMarkdown: "Stale writer instructions.",
      },
      [400],
    );
    await staleUploadStarted.promise;
    const winner = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: "Winning Writer",
        prefixTemplates: created.prefixTemplates,
        fields: created.fields,
        headerInjections: created.headerInjections,
        queryInjections: created.queryInjections,
        authMode: created.authMode,
        skillMarkdown: "Winning writer instructions.",
      },
    );
    const winningHead = await storagesApi.downloadStorage(admin, {
      name: storageName,
      owner: "organization",
    });
    releaseStaleUpload.resolve();
    const staleResponse = await staleRequest;

    expect(staleResponse.status).toBe(400);
    expectApiError(staleResponse.body);
    expect(staleResponse.body.error.message).toContain(
      "changed while the definition was being saved",
    );
    expect(winningHead.versionId).not.toBe(initialHead.versionId);
    await expect(
      connectorsApi.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({
      displayName: winner.displayName,
      skillMarkdown: "Winning writer instructions.",
    });
    await expect(
      storagesApi.downloadStorage(admin, {
        name: storageName,
        owner: "organization",
      }),
    ).resolves.toMatchObject({ versionId: winningHead.versionId });

    await connectorsApi.deleteCustomConnector(admin, created.id);
  });

  it("publishes exact skill versions and retains them after clearing and deletion", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    const slug = uniqueSlug("bdd-permission-skill");

    const created = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(slug),
      permissionBundleRef: "builtin:slack@1",
      skillMarkdown: "Use this connector to coordinate Slack conversations.",
    });
    expect(created).toMatchObject({
      permissionBundleRef: "builtin:slack@1",
      skillMarkdown: "Use this connector to coordinate Slack conversations.",
    });
    const storageName = getCustomConnectorSkillStorageName(created.id);
    const createdHead = await storagesApi.downloadStorage(admin, {
      name: storageName,
      owner: "organization",
    });

    const skillUpdated = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: created.displayName,
        prefixTemplates: created.prefixTemplates,
        fields: created.fields,
        headerInjections: created.headerInjections,
        queryInjections: created.queryInjections,
        authMode: created.authMode,
        skillMarkdown: "Updated Slack operating instructions.",
      },
    );
    expect(skillUpdated).toMatchObject({
      permissionBundleRef: "builtin:slack@1",
      skillMarkdown: "Updated Slack operating instructions.",
    });
    const updatedHead = await storagesApi.downloadStorage(admin, {
      name: storageName,
      owner: "organization",
    });
    expect(updatedHead.versionId).not.toBe(createdHead.versionId);
    await expect(
      storagesApi.downloadStorage(admin, {
        name: storageName,
        owner: "organization",
        version: createdHead.versionId,
      }),
    ).resolves.toMatchObject({ versionId: createdHead.versionId });

    const permissionBundleCleared = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: skillUpdated.displayName,
        prefixTemplates: skillUpdated.prefixTemplates,
        fields: skillUpdated.fields,
        headerInjections: skillUpdated.headerInjections,
        queryInjections: skillUpdated.queryInjections,
        authMode: skillUpdated.authMode,
        permissionBundleRef: null,
      },
    );
    expect(permissionBundleCleared).toMatchObject({
      permissionBundleRef: null,
      skillMarkdown: "Updated Slack operating instructions.",
    });

    const unknownBundle = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...customConnectorBody(uniqueSlug("bdd-unknown-bundle")),
        permissionBundleRef: "builtin:not-a-connector@1",
      },
      [400],
    );
    expectApiError(unknownBundle.body);
    expect(unknownBundle.body.error.message).toContain(
      "Unknown custom connector permission bundle",
    );

    const skillCleared = await connectorsApi.updateCustomConnector(
      admin,
      created.id,
      {
        displayName: permissionBundleCleared.displayName,
        prefixTemplates: permissionBundleCleared.prefixTemplates,
        fields: permissionBundleCleared.fields,
        headerInjections: permissionBundleCleared.headerInjections,
        queryInjections: permissionBundleCleared.queryInjections,
        authMode: permissionBundleCleared.authMode,
        skillMarkdown: null,
      },
    );
    expect(skillCleared.skillMarkdown).toBeNull();
    await expect(
      storagesApi.downloadStorage(admin, {
        name: storageName,
        owner: "organization",
      }),
    ).resolves.toMatchObject({ versionId: updatedHead.versionId });

    await connectorsApi.deleteCustomConnector(admin, created.id);
    await expect(
      storagesApi.downloadStorage(admin, {
        name: storageName,
        owner: "organization",
        version: updatedHead.versionId,
      }),
    ).resolves.toMatchObject({ versionId: updatedHead.versionId });
  });

  it("rejects prefix collisions introduced by edits", async () => {
    const admin = createBddApi(context).user();
    const original = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-prefix-original")),
      displayName: "BDD Prefix Original",
    });
    const editable = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-prefix-editable")),
      displayName: "BDD Prefix Editable",
    });
    const originalPrefix = original.prefixTemplates[0];
    if (!originalPrefix) {
      throw new Error("Expected the original connector to have a prefix");
    }

    const collision = await connectorsApi.requestUpdateCustomConnector(
      admin,
      editable.id,
      {
        displayName: editable.displayName,
        prefixTemplates: [originalPrefix.slice(0, -1)],
        fields: editable.fields,
        headerInjections: editable.headerInjections,
        queryInjections: editable.queryInjections,
        authMode: editable.authMode,
      },
      [400],
    );
    expectApiError(collision.body);
    expect(collision.body.error.message).toContain(`"${original.displayName}"`);
    expect(
      (await connectorsApi.listCustomConnectors(admin)).find((connector) => {
        return connector.id === editable.id;
      })?.prefixTemplates,
    ).toStrictEqual(editable.prefixTemplates);

    await connectorsApi.deleteCustomConnector(admin, original.id);
    await connectorsApi.deleteCustomConnector(admin, editable.id);
  });

  it("serializes concurrent creates for the same normalized prefix", async () => {
    const admin = createBddApi(context).user();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const prefix = `https://concurrent-${rand}.example.test/v1/`;
    const responses = await Promise.all([
      connectorsApi.requestCreateCustomConnector(
        admin,
        {
          ...customConnectorBody(uniqueSlug("bdd-prefix-concurrent-a")),
          displayName: "BDD Concurrent Prefix A",
          prefixTemplates: [prefix],
        },
        [201, 400],
      ),
      connectorsApi.requestCreateCustomConnector(
        admin,
        {
          ...customConnectorBody(uniqueSlug("bdd-prefix-concurrent-b")),
          displayName: "BDD Concurrent Prefix B",
          prefixTemplates: [prefix.slice(0, -1)],
        },
        [201, 400],
      ),
    ]);

    expect(
      responses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 400]);
    const created = responses.find((response) => {
      return response.status === 201;
    });
    const rejected = responses.find((response) => {
      return response.status === 400;
    });
    if (created?.status !== 201 || rejected?.status !== 400) {
      throw new Error("Expected one created and one rejected connector");
    }
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain("is already used");

    await connectorsApi.deleteCustomConnector(admin, created.body.id);
  });

  it("scopes custom connector deletion to org admins and same-org ids", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const otherAdmin = bdd.user();

    const mine = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-own")),
      displayName: "Original",
    });
    const foreign = await connectorsApi.createCustomConnector(otherAdmin, {
      ...customConnectorBody(uniqueSlug("bdd-foreign")),
      displayName: "OtherOrg",
    });

    const memberDelete = await connectorsApi.requestDeleteCustomConnector(
      member,
      mine.id,
      [403],
    );
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe(
      "Only org admins can delete custom connectors",
    );

    const myList = await connectorsApi.listCustomConnectors(admin);
    expect(
      myList.find((connector) => {
        return connector.id === mine.id;
      })?.displayName,
    ).toBe("Original");

    const unknownDelete = await connectorsApi.requestDeleteCustomConnector(
      admin,
      randomUUID(),
      [404],
    );
    expectApiError(unknownDelete.body);
    expect(unknownDelete.body.error.code).toBe("NOT_FOUND");

    const crossOrgDelete = await connectorsApi.requestDeleteCustomConnector(
      admin,
      foreign.id,
      [404],
    );
    expectApiError(crossOrgDelete.body);
    expect(crossOrgDelete.body.error.code).toBe("NOT_FOUND");

    const otherList = await connectorsApi.listCustomConnectors(otherAdmin);
    expect(
      otherList.find((connector) => {
        return connector.id === foreign.id;
      })?.displayName,
    ).toBe("OtherOrg");

    await connectorsApi.setCustomConnectorSecret(
      otherAdmin,
      foreign.id,
      "foreign-secret-value",
    );
    await connectorsApi.deleteCustomConnector(admin, mine.id);
    await connectorsApi.deleteCustomConnector(otherAdmin, foreign.id);
    const afterDelete = await connectorsApi.listCustomConnectors(otherAdmin);
    expect(
      afterDelete.find((connector) => {
        return connector.id === foreign.id;
      }),
    ).toBeUndefined();
  });

  it("keeps custom connector secrets scoped per user and per organization", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const adminInOtherOrg = bdd.user({ userId: admin.userId });

    const shared = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(uniqueSlug("bdd-secret")),
    );
    const otherOrg = await connectorsApi.createCustomConnector(
      adminInOtherOrg,
      customConnectorBody(uniqueSlug("bdd-other-secret")),
    );

    async function readConnected(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<boolean | undefined> {
      const connectors = await connectorsApi.listCustomConnectors(actor);
      return connectors.find((connector) => {
        return connector.id === connectorId;
      })?.connected;
    }

    const missing = await connectorsApi.requestSetCustomConnectorSecret(
      admin,
      randomUUID(),
      "unused-secret-value",
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Custom connector not found");

    await connectorsApi.setCustomConnectorSecret(
      member,
      shared.id,
      "member-secret-value",
    );
    await expect(readConnected(member, shared.id)).resolves.toBeTruthy();
    await expect(readConnected(admin, shared.id)).resolves.toBeFalsy();

    await connectorsApi.setCustomConnectorSecret(
      admin,
      shared.id,
      "admin-secret-value",
    );
    const [adminAccount] = await connectorsApi.listCustomConnectorAccounts(
      admin,
      shared.id,
    );
    if (!adminAccount) {
      throw new Error("Expected the admin custom connector account");
    }
    await connectorsApi.setCustomConnectorSecret(
      admin,
      shared.id,
      "admin-secret-value-rotated",
      [200],
      { intent: "reconnect", connectionId: adminAccount.id },
    );
    const adminList = await connectorsApi.listCustomConnectors(admin);
    expect(
      adminList.find((connector) => {
        return connector.id === shared.id;
      })?.connected,
    ).toBeTruthy();
    expectNoVisibleSecret(adminList, "admin-secret-value");
    expectNoVisibleSecret(adminList, "member-secret-value");

    await connectorsApi.setCustomConnectorSecret(
      adminInOtherOrg,
      otherOrg.id,
      "other-org-secret-value",
    );
    await expect(
      readConnected(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeTruthy();

    await connectorsApi.deleteDefaultCustomConnectorAccount(admin, shared.id);
    await expect(readConnected(admin, shared.id)).resolves.toBeFalsy();
    await expect(readConnected(member, shared.id)).resolves.toBeTruthy();
    await expect(
      readConnected(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeTruthy();

    await connectorsApi.deleteCustomConnector(admin, shared.id);
    await connectorsApi.deleteCustomConnector(adminInOtherOrg, otherOrg.id);
    await expect(readConnected(admin, shared.id)).resolves.toBeUndefined();
    await expect(
      readConnected(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeUndefined();
  });
});

describe("CONN-02: OAuth callback validation and state claiming", () => {
  it("rejects malformed and unclaimable callbacks through visible redirects", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const unknownSlug = await connectorsApi.completeOauthCallback("invalid", {
      code: "code-123",
      state: "state-123",
    });
    expectConnectorErrorRedirect(unknownSlug, {
      connectorSlug: "invalid",
      message: "Unknown connector slug",
    });

    const manualOnly = await connectorsApi.completeOauthCallback("cloudinary", {
      code: "code-123",
      state: "state-123",
    });
    expectConnectorErrorRedirect(manualOnly, {
      connectorSlug: "cloudinary",
      message: "cloudinary connector does not use an auth-code grant",
    });

    const deviceOnly = await connectorsApi.completeOauthCallback(
      "test-oauth-device",
      { code: "code-123", state: "state-123" },
    );
    expectConnectorErrorRedirect(deviceOnly, {
      connectorSlug: "test-oauth-device",
      message: "test-oauth-device connector does not use an auth-code grant",
    });

    const unclaimable = await connectorsApi.completeOauthCallback("github", {
      code: "code-123",
      state: "bdd-never-stored-state",
    });
    expectConnectorErrorRedirect(unclaimable, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });
    expect(unclaimable.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );

    const missingState = await connectorsApi.completeOauthCallback("github", {
      code: "code-123",
    });
    expectConnectorErrorRedirect(missingState, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const crossType = await connectorsApi.completeOauthCallback("linear", {
      code: "code-123",
      state,
    });
    expectConnectorErrorRedirect(crossType, {
      connectorSlug: "linear",
      message: "Invalid state - please try again",
    });

    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(successUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(successUrl.searchParams.get("username")).toBe("bdd-github-user");

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(connected).toMatchObject({
      slug: "github",
      authMethod: "oauth",
      connectionStatus: "connected",
    });

    const linearMissing = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "linear",
      [404],
    );
    expectApiError(linearMissing.body);
    expect(linearMissing.body.error.code).toBe("NOT_FOUND");
  });

  it("claims, preserves, and invalidates stored OAuth state across code-less, error, and expired callbacks", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const missingCode = await connectorsApi.completeOauthCallback("github", {
      state,
    });
    expectConnectorErrorRedirect(missingCode, {
      connectorSlug: "github",
      message: "Missing authorization code",
    });
    expect(missingCode.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );

    const unknownState = await connectorsApi.completeOauthCallback("github", {
      state: "bdd-unknown-state",
    });
    expectConnectorErrorRedirect(unknownState, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("username")).toBe("bdd-github-user");

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");

    const missingCodeStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
    );
    const reconnectWithoutCode = await connectorsApi.completeOauthCallback(
      "github",
      { state: stateFromAuthorizationUrl(missingCodeStart.authorizationUrl) },
    );
    expectConnectorErrorRedirect(reconnectWithoutCode, {
      connectorSlug: "github",
      message: "Missing authorization code",
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toStrictEqual(connected);

    const deniedStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
    );
    const denied = await connectorsApi.completeOauthCallback("github", {
      error: "access_denied",
      error_description: "Provider denied access",
      state: stateFromAuthorizationUrl(deniedStart.authorizationUrl),
    });
    expectConnectorErrorRedirect(denied, {
      connectorSlug: "github",
      message: "Provider denied access",
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toStrictEqual(connected);

    const consumedWithoutCode = await connectorsApi.completeOauthCallback(
      "github",
      { state },
    );
    expectConnectorErrorRedirect(consumedWithoutCode, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const consumedProviderError = await connectorsApi.completeOauthCallback(
      "github",
      {
        error: "access_denied",
        error_description: "Provider denied access",
        state,
      },
    );
    expectConnectorErrorRedirect(consumedProviderError, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const stable = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(stable.id).toBe(connected.id);
    expect(stable.externalUsername).toBe("bdd-github-user");

    const expiringStartedAt = now();
    mockNow(expiringStartedAt);
    const expiringStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
    );
    const expiringState = stateFromAuthorizationUrl(
      expiringStart.authorizationUrl,
    );
    mockNow(expiringStartedAt + 15 * 60 * 1000);
    const expired = await connectorsApi.completeOauthCallback("github", {
      code: "github-late-code",
      state: expiringState,
    });
    expectConnectorErrorRedirect(expired, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });
    clearMockNow();

    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toStrictEqual(connected);
  });

  it("routes callbacks through canonical and trusted web origins", async () => {
    mockEnv("OKOU_WEB_URL", "https://app.okou.test");

    const canonical = await requestOauthCallbackRaw(context, {
      origin: "https://api.okou.ai",
      connectorSlug: "github",
      query: { code: "code-123", state: "state-123" },
    });
    expect(canonical.status).toBe(307);
    expect(canonical.headers.get("location")).toBe(
      "https://www.okou.ai/api/connectors/github/callback?code=code-123&state=state-123",
    );

    const trustedHeader = await requestOauthCallbackRaw(context, {
      origin: "https://api.okou.ai",
      connectorSlug: "github",
      query: { code: "code-123" },
      headers: { "x-okou-web-origin": "https://www.okou.ai" },
    });
    expect(trustedHeader.status).toBe(307);
    const trustedUrl = redirectLocation(trustedHeader);
    expect(trustedUrl.origin).toBe("https://app.okou.test");
    expectConnectorErrorRedirect(trustedHeader, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });

    const nonApiHost = await requestOauthCallbackRaw(context, {
      origin: "https://app.okou.test",
      connectorSlug: "github",
      query: { code: "code-123" },
    });
    expect(nonApiHost.status).toBe(307);
    const nonApiUrl = redirectLocation(nonApiHost);
    expect(nonApiUrl.origin).toBe("https://app.okou.test");
    expectConnectorErrorRedirect(nonApiHost, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });
  });
});

describe("CONN-02: test-oauth auth-code journey", () => {
  it("persists reported and normalized effective scopes through auth-code callbacks", async () => {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const supplementalProvider = mockTestOAuthAuthCodeProvider({
      accessToken: "bdd-test-oauth-supplemental-token",
      scope: "read provider-added",
    });
    const supplementalStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const supplementalCallback = await connectorsApi.completeOauthCallback(
      "test-oauth",
      {
        code: "bdd-test-oauth-supplemental-code",
        state: stateFromAuthorizationUrl(supplementalStart.authorizationUrl),
      },
    );
    expect(redirectLocation(supplementalCallback).pathname).toBe(
      "/connector/success",
    );
    expect(supplementalProvider.tokenBodies).toHaveLength(1);

    const supplemental = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(supplemental).toMatchObject({
      oauthScopes: ["read", "provider-added"],
      connectionStatus: "connected",
    });

    await expect(
      connectorsApi.readScopeDiff(actor, "test-oauth"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["read"],
      storedScopes: ["read"],
    });

    await setBuiltinOAuthScopeFacts(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorSlug: "test-oauth",
      connectorId: supplemental.id,
      oauthScopes: ["read", "legacy-write"],
      oauthGrantedScopes: null,
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth"),
    ).resolves.toMatchObject({
      id: supplemental.id,
      oauthScopes: null,
      connectionStatus: "connected",
    });
    await expect(
      connectorsApi.readScopeDiff(actor, "test-oauth"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: ["legacy-write"],
      currentScopes: ["read"],
      storedScopes: ["read", "legacy-write"],
    });

    const omittedProvider = mockTestOAuthAuthCodeProvider({
      accessToken: "bdd-test-oauth-omitted-scope-token",
      scope: null,
    });
    const omittedStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: supplemental.id },
    );
    expect(
      new URL(omittedStart.authorizationUrl).searchParams.get("scope"),
    ).toBe("read");
    const omittedCallback = await connectorsApi.completeOauthCallback(
      "test-oauth",
      {
        code: "bdd-test-oauth-omitted-scope-code",
        state: stateFromAuthorizationUrl(omittedStart.authorizationUrl),
      },
    );
    expect(redirectLocation(omittedCallback).pathname).toBe(
      "/connector/success",
    );
    expect(omittedProvider.tokenBodies).toHaveLength(1);

    const normalized = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(normalized).toMatchObject({
      id: supplemental.id,
      oauthScopes: ["read"],
      connectionStatus: "connected",
    });

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth",
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("replaces a manual-grant connection through the auth-code callback with method-scoped state cleanup", async () => {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const provider = mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-test-oauth-refresh",
    });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "OAuth Connector Agent",
    });

    const manualConnection = await connectorsApi.connectManualGrant(
      actor,
      "test-oauth",
      "api-token",
      {
        apiToken: "bdd-manual-test-oauth-token",
        inputVariable: "bdd-input-variable",
        tenantId: "bdd-manual-tenant",
      },
    );
    const manual = await connectorsApi.readConnectorBySlug(actor, "test-oauth");
    expect(manual.authMethod).toBe("api-token");

    const start = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      agent.agentId,
      { intent: "reconnect", connectionId: manualConnection.id },
    );
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "http://localhost:3000/api/test/oauth-provider/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-oauth-client",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const success = await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-test-oauth-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("connectorSlug")).toBe("test-oauth");
    expect(successUrl.searchParams.get("connectorSlug")).toBe("test-oauth");
    expect(successUrl.searchParams.get("username")).toBe("bdd-test-oauth");

    expect(provider.tokenBodies).toHaveLength(1);
    const exchangeBody = provider.tokenBodies[0];
    expect(exchangeBody?.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody?.get("client_id")).toBe("test-oauth-client");
    expect(exchangeBody?.get("client_secret")).toBe("test-oauth-secret");
    expect(exchangeBody?.get("code")).toBe("bdd-test-oauth-code");
    expect(exchangeBody?.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/test-oauth/callback",
    );

    const oauthConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(oauthConnector).toMatchObject({
      slug: "test-oauth",
      authMethod: "oauth",
      externalId: "bdd-test-oauth-user",
      externalUsername: "bdd-test-oauth",
      externalEmail: "bdd-test-oauth@example.test",
      oauthScopes: ["read"],
      connectionStatus: "connected",
    });
    expectNoVisibleSecret(oauthConnector, "bdd-test-oauth-access-token");
    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, agent.agentId),
    ).resolves.toContain("test-oauth");

    const listed = await connectorsApi.listConnectors(actor);
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "test-oauth",
        authMethod: "oauth",
        namespace: "secrets",
        name: "TEST_OAUTH_TOKEN",
        source: { kind: "connector-secret", name: "TEST_OAUTH_ACCESS_TOKEN" },
      }),
    );
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "test-oauth",
        authMethod: "oauth",
        namespace: "vars",
        name: "TEST_OAUTH_TENANT_ID",
        source: {
          kind: "connector-variable",
          name: "TEST_OAUTH_API_TENANT_ID",
        },
      }),
    );
    expect(
      listed.connectorProvidedBindings.filter((binding) => {
        return (
          binding.connectorSlug === "test-oauth" &&
          binding.authMethod === "api-token"
        );
      }),
    ).toStrictEqual([]);
    expectNoVisibleSecret(listed, "bdd-manual-test-oauth-token");
    expectNoVisibleSecret(listed, "bdd-test-oauth-access-token");

    await expect(
      connectorsApi.readScopeDiff(actor, "test-oauth"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["read"],
      storedScopes: ["read"],
    });

    const apiProvider = mockTestOAuthAuthCodeProvider({
      accessToken: "bdd-test-oauth-api-access-token",
      refreshToken: "bdd-test-oauth-api-refresh",
    });
    const apiStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "api",
      undefined,
      { intent: "reconnect", connectionId: oauthConnector.id },
    );
    const apiState = stateFromAuthorizationUrl(apiStart.authorizationUrl);
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-test-oauth-api-code",
      state: apiState,
    });
    expect(apiProvider.tokenBodies).toHaveLength(1);

    const apiConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(apiConnector.authMethod).toBe("api");

    const apiListed = await connectorsApi.listConnectors(actor);
    expect(apiListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "test-oauth",
        authMethod: "api",
        namespace: "secrets",
        name: "TEST_OAUTH_TOKEN",
        source: {
          kind: "connector-secret",
          name: "TEST_OAUTH_API_ACCESS_TOKEN",
        },
      }),
    );
    expectNoVisibleSecret(apiListed, "bdd-test-oauth-api-access-token");

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth",
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("rolls back failed OAuth-to-manual credential replacement before a successful retry", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-rollback-refresh-token",
    });

    const initial = await connectorsApi.connectManualGrant(
      actor,
      "test-oauth",
      "api-token",
      {
        apiToken: "bdd-rollback-manual-token",
        inputVariable: "bdd-rollback-input",
        tenantId: "bdd-rollback-manual-tenant",
      },
    );

    const oauthStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: initial.id },
    );
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-rollback-oauth-code",
      state: stateFromAuthorizationUrl(oauthStart.authorizationUrl),
    });
    const oauthConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(oauthConnector).toMatchObject({
      id: initial.id,
      authMethod: "oauth",
      externalId: "bdd-test-oauth-user",
      oauthScopes: ["read"],
    });
    const storageQuery = {
      orgId: requiredOrgId(actor),
      userId: actor.userId,
      connectorSlug: "test-oauth",
      secretNames: [
        "TEST_OAUTH_TOKEN",
        "TEST_OAUTH_ACCESS_TOKEN",
        "TEST_OAUTH_REFRESH_TOKEN",
      ],
      variableNames: [
        "TEST_OAUTH_API_TOKEN_INPUT_VAR",
        "TEST_OAUTH_API_TENANT_ID",
      ],
    };
    const storageBeforeFailure = await readConnectorCredentialStorageState(
      context,
      storageQuery,
    );

    const failed = await connectorsApi.requestManualGrant(
      actor,
      "test-oauth",
      "api-token",
      {
        apiToken: "bdd-failed-replacement-token",
        // PostgreSQL text rejects NUL after the transaction has replaced the
        // connection metadata, deleted OAuth credentials, and written the secret.
        inputVariable: "bdd-failed-replacement-input\u0000",
        tenantId: "bdd-failed-replacement-tenant",
      },
      {
        statuses: [500],
        account: { intent: "reconnect", connectionId: oauthConnector.id },
      },
    );
    expect(failed.status).toBe(500);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth"),
    ).resolves.toStrictEqual(oauthConnector);
    await expect(
      readConnectorCredentialStorageState(context, storageQuery),
    ).resolves.toStrictEqual(storageBeforeFailure);

    const manual = await connectorsApi.connectManualGrant(
      actor,
      "test-oauth",
      "api-token",
      {
        apiToken: "bdd-successful-replacement-token",
        inputVariable: "bdd-successful-replacement-input",
        tenantId: "bdd-successful-replacement-tenant",
      },
      undefined,
      { intent: "reconnect", connectionId: oauthConnector.id },
    );
    expect(manual).toMatchObject({
      id: oauthConnector.id,
      authMethod: "api-token",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      tokenExpiresAt: null,
    });
    const manualStorage = await readConnectorCredentialStorageState(
      context,
      storageQuery,
    );
    expect(
      manualStorage.secrets?.map(({ name }) => {
        return name;
      }),
    ).toStrictEqual(["TEST_OAUTH_TOKEN"]);
    expect(
      manualStorage.variables
        ?.map(({ name }) => {
          return name;
        })
        .sort((left, right) => {
          return left.localeCompare(right);
        }),
    ).toStrictEqual([
      "TEST_OAUTH_API_TENANT_ID",
      "TEST_OAUTH_API_TOKEN_INPUT_VAR",
    ]);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth",
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("stores token expiry variants and surfaces provider failures", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-refresh-v1",
      expiresIn: 7200,
    });
    const explicitStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const explicitBefore = now();
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-v1",
      state: stateFromAuthorizationUrl(explicitStart.authorizationUrl),
    });
    const explicitAfter = now();
    const explicitExpiry = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    if (!explicitExpiry.tokenExpiresAt) {
      throw new Error("Expected an explicit token expiry to be stored");
    }
    const explicitExpiryMs = Date.parse(explicitExpiry.tokenExpiresAt);
    expect(explicitExpiryMs).toBeGreaterThanOrEqual(
      explicitBefore + 7200 * 1000,
    );
    expect(explicitExpiryMs).toBeLessThanOrEqual(explicitAfter + 7200 * 1000);

    mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-refresh-v2",
      omitExpiresIn: true,
    });
    const defaultStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: explicitExpiry.id },
    );
    const defaultBefore = now();
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-v2",
      state: stateFromAuthorizationUrl(defaultStart.authorizationUrl),
    });
    const defaultAfter = now();
    const defaultExpiry = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(defaultExpiry.id).toBe(explicitExpiry.id);
    if (!defaultExpiry.tokenExpiresAt) {
      throw new Error("Expected the default token expiry to be stored");
    }
    const defaultExpiryMs = Date.parse(defaultExpiry.tokenExpiresAt);
    expect(defaultExpiryMs).toBeGreaterThanOrEqual(
      defaultBefore + 15 * 60 * 1000,
    );
    expect(defaultExpiryMs).toBeLessThanOrEqual(defaultAfter + 15 * 60 * 1000);
    const storageBeforeFailures = await readConnectorCredentialStorageState(
      context,
      {
        orgId: requiredOrgId(actor),
        userId: actor.userId,
        connectorSlug: "test-oauth",
        secretNames: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
        variableNames: ["TEST_OAUTH_API_TENANT_ID"],
      },
    );

    mockSlackConnectorOAuth();
    const slackStart = await connectorsApi.startOauth(actor, "slack", "oauth");
    await connectorsApi.completeOauthCallback("slack", {
      code: "bdd-slack-code",
      state: stateFromAuthorizationUrl(slackStart.authorizationUrl),
    });
    const slackConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "slack",
    );
    expect(slackConnector).toMatchObject({
      slug: "slack",
      authMethod: "oauth",
      externalId: "U012AB3CD",
      externalUsername: "BDD Slack User",
      connectionStatus: "connected",
    });
    expect(slackConnector.tokenExpiresAt).toBeNull();
    expectNoVisibleSecret(slackConnector, "xoxp-bdd-user-token");

    mockTestOAuthAuthCodeProvider({ tokenError: true });
    const tokenFailStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: defaultExpiry.id },
    );
    const tokenFail = await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-token-fail",
      state: stateFromAuthorizationUrl(tokenFailStart.authorizationUrl),
    });
    expectConnectorErrorRedirect(tokenFail, {
      connectorSlug: "test-oauth",
      message: "OAuth authorization failed. Please try again.",
    });
    expect(tokenFail.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );
    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth"),
    ).resolves.toStrictEqual(defaultExpiry);
    await expect(
      readConnectorCredentialStorageState(context, {
        orgId: requiredOrgId(actor),
        userId: actor.userId,
        connectorSlug: "test-oauth",
        secretNames: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
        variableNames: ["TEST_OAUTH_API_TENANT_ID"],
      }),
    ).resolves.toStrictEqual(storageBeforeFailures);

    mockTestOAuthAuthCodeProvider({ userinfoError: true });
    const userinfoFailStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: defaultExpiry.id },
    );
    const userinfoFail = await connectorsApi.completeOauthCallback(
      "test-oauth",
      {
        code: "bdd-code-userinfo-fail",
        state: stateFromAuthorizationUrl(userinfoFailStart.authorizationUrl),
      },
    );
    expectConnectorErrorRedirect(userinfoFail, {
      connectorSlug: "test-oauth",
      message: "OAuth authorization failed. Please try again.",
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth"),
    ).resolves.toStrictEqual(defaultExpiry);
    await expect(
      readConnectorCredentialStorageState(context, {
        orgId: requiredOrgId(actor),
        userId: actor.userId,
        connectorSlug: "test-oauth",
        secretNames: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
        variableNames: ["TEST_OAUTH_API_TENANT_ID"],
      }),
    ).resolves.toStrictEqual(storageBeforeFailures);

    mockTestOAuthAuthCodeProvider({
      accessToken: "bdd-replacement-account-token",
      userId: "bdd-test-oauth-replacement-user",
      username: "bdd-test-oauth-replacement",
      email: "bdd-test-oauth-replacement@example.test",
    });
    const replacementStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-replacement-account",
      state: stateFromAuthorizationUrl(replacementStart.authorizationUrl),
    });
    const replacementAccounts =
      await connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth");
    const replacementAccount = replacementAccounts.find((account) => {
      return account.externalId === "bdd-test-oauth-replacement-user";
    });
    expect(replacementAccount).toMatchObject({
      externalId: "bdd-test-oauth-replacement-user",
      externalUsername: "bdd-test-oauth-replacement",
      externalEmail: "bdd-test-oauth-replacement@example.test",
    });
    expect(replacementAccount?.id).not.toBe(defaultExpiry.id);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "slack");
    await connectorsApi.deleteFeatureSwitches(actor);
  });
});

describe("CONN-02: device-auth method switching", () => {
  it("switches device-auth methods without deleting the connector", async () => {
    mockTestOAuthDeviceConnectorProvider();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const apiSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
    );
    const apiPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      apiSession.sessionId,
      apiSession.sessionToken,
    );
    expect(apiPoll.status).toBe("complete");
    if (apiPoll.status !== "complete") {
      throw new Error(
        `Expected complete api device auth, received ${apiPoll.status}`,
      );
    }
    expect(apiPoll.connector.authMethod).toBe("api");

    const apiListed = await connectorsApi.listConnectors(actor);
    expect(apiListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "test-oauth-device",
        authMethod: "api",
        namespace: "secrets",
        name: "TEST_OAUTH_DEVICE_API_TOKEN",
      }),
    );

    const oauthSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: apiPoll.connector.id },
    );
    const oauthPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      oauthSession.sessionId,
      oauthSession.sessionToken,
    );
    expect(oauthPoll.status).toBe("complete");
    if (oauthPoll.status !== "complete") {
      throw new Error(
        `Expected complete oauth device auth, received ${oauthPoll.status}`,
      );
    }
    expect(oauthPoll.connector.authMethod).toBe("oauth");

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(apiPoll.connector.id);
    expect(readBack.authMethod).toBe("oauth");

    const oauthListed = await connectorsApi.listConnectors(actor);
    expect(
      oauthListed.connectorProvidedBindings.filter((binding) => {
        return (
          binding.connectorSlug === "test-oauth-device" &&
          binding.authMethod === "api"
        );
      }),
    ).toStrictEqual([]);
    expect(oauthListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "test-oauth-device",
        authMethod: "oauth",
        namespace: "secrets",
        name: "TEST_OAUTH_DEVICE_TOKEN",
      }),
    );

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });
});

describe("CONN-02: GitHub installation link after connector OAuth", () => {
  it("links the org GitHub installation when the GitHub connector completes OAuth", async () => {
    mockGitHubConnectorOAuth();
    const installationId = String(randomInt(100_000_000, 999_999_999));
    const targetId = String(randomInt(100_000_000, 999_999_999));
    mockGithubAppInstallProvider({ installationId, targetId });

    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user();
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD GitHub Link Agent",
    });

    await connectorsApi.installGithubAppViaApi(
      admin,
      agent.agentId,
      installationId,
    );

    const beforeLink = await connectorsApi.readGithubIntegration(admin);
    expect(beforeLink.installation).toMatchObject({
      installationId,
      status: "active",
      targetType: "Organization",
      targetName: "bdd-github-org",
      isAdmin: true,
    });
    expect(beforeLink.isConnected).toBeFalsy();
    expect(beforeLink.connectedGithubUserId).toBeNull();

    const start = await connectorsApi.startOauth(admin, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);
    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    expect(redirectLocation(success).pathname).toBe("/connector/success");

    const afterLink = await connectorsApi.readGithubIntegration(admin);
    expect(afterLink.isConnected).toBeTruthy();
    expect(afterLink.connectedGithubUserId).toBe("42");
    expect(afterLink.connectedGithubUsername).toBe("bdd-github-user");

    const connectorState = await readConnectorCredentialStorageState(context, {
      orgId: admin.orgId ?? "",
      userId: admin.userId,
      connectorSlug: "github",
    });
    const connectorId = connectorState.connector?.id;
    if (!connectorId) {
      throw new Error("Expected a stored GitHub connector account");
    }
    await setConnectorDefaultState(context, {
      orgId: admin.orgId ?? "",
      userId: admin.userId,
      connectorId,
      isDefault: false,
    });
    const withoutDefault = await connectorsApi.readGithubIntegration(admin);
    expect(withoutDefault.isConnected).toBeTruthy();
    expect(withoutDefault.connectedGithubUserId).toBe("42");
    expect(withoutDefault.connectedGithubUsername).toBeNull();

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(admin, "github");
  });
});
