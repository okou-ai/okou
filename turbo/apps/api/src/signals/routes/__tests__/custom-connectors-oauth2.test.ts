import { readGetStartedStatus } from "./helpers/get-started";
import { randomBytes, randomUUID } from "node:crypto";

import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  readCustomConnectorOAuthStorageState,
  seedCustomConnectorOAuthStateContext,
} from "./helpers/connector-credential-storage-state";

const context = testContext();
const connectors = createConnectorBddApi(context);

type CustomOAuthProvider = ReturnType<typeof mockCustomConnectorOAuth2Provider>;

function customOAuthConnectorBody(
  provider: CustomOAuthProvider,
): CreateCustomConnectorBody {
  return {
    displayName: `Branded OAuth ${randomUUID()}`,
    prefixTemplates: [`https://${randomUUID()}.branded-oauth.example.test/v1/`],
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
      clientId: "branded-oauth-client-id",
      clientSecret: "branded-oauth-client-secret",
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "none",
      scopes: ["read"],
      authorizationParams: {},
    },
  };
}

function authorizationState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  if (!state) {
    throw new Error("Expected custom connector OAuth state");
  }
  return state;
}

function redirectLocation(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected custom connector OAuth redirect");
  }
  return new URL(location);
}

function requiredOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected custom connector OAuth actor organization");
  }
  return actor.orgId;
}

async function createCustomOAuthConnector(
  actor: ApiTestUser,
  provider: CustomOAuthProvider,
) {
  return await connectors.createCustomConnector(
    actor,
    customOAuthConnectorBody(provider),
  );
}

describe("Custom connector OAuth callbacks", () => {
  it("uses the configured Okou App callback for authorization and token exchange", async () => {
    const apiOrigin = "https://api.okou.ai";
    const appOrigin = "https://app.okou.ai";
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createCustomOAuthConnector(actor, provider);
    const callbackUri = `${appOrigin}/connectors/custom/callback`;

    const authorizationUrl = new URL(
      await connectors.startCustomConnectorOAuth2AtBaseUrl(
        actor,
        connector.id,
        apiOrigin,
      ),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callbackUri);
    const state = authorizationState(authorizationUrl);
    expect(state).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      readCustomConnectorOAuthStorageState(context, state),
    ).resolves.toMatchObject({
      custom_oauth_state: {
        auth_mode: "oauth",
        context_valid: true,
      },
    });

    const callback = await connectors.completeCustomConnectorOAuth2Callback(
      { code: `${actor.userId}-code`, state },
      { baseUrl: apiOrigin },
    );
    expect(redirectLocation(callback).toString()).toBe(
      `${callbackUri}/success`,
    );
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(callbackUri);

    await connectors.deleteCustomConnector(actor, connector.id);
  });

  it("does not derive the provider callback from an untrusted API host", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createCustomOAuthConnector(actor, provider);
    const callbackUri = "https://app.okou.ai/connectors/custom/callback";

    const authorizationUrl = new URL(
      await connectors.startCustomConnectorOAuth2AtBaseUrl(
        actor,
        connector.id,
        "https://api.okou.ai.attacker.example",
      ),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callbackUri);
    const state = authorizationState(authorizationUrl);
    expect(state).toMatch(/^[0-9a-f]{64}$/u);

    await connectors.completeCustomConnectorOAuth2Callback(
      { code: "untrusted-host-code", state },
      { baseUrl: "https://api.okou.ai.attacker.example" },
    );
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(callbackUri);

    await connectors.deleteCustomConnector(actor, connector.id);
  });

  it("completes a canonical custom OAuth state callback", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createCustomOAuthConnector(actor, provider);
    const redirectUri = "https://app.okou.ai/connectors/custom/callback";
    const state = `okou.${randomBytes(32).toString("hex")}`;

    await seedCustomConnectorOAuthStateContext(context, {
      state,
      orgId: requiredOrgId(actor),
      userId: actor.userId,
      customConnectorId: connector.id,
      storageVersion: connector.storageVersion,
      redirectUri,
      oauthContext: {
        version: 2,
        authMode: "oauth",
        connectorId: connector.id,
        storageVersion: connector.storageVersion,
      },
    });

    const callback = await connectors.completeCustomConnectorOAuth2Callback(
      { code: "canonical-okou-code", state },
      { baseUrl: "https://api.okou.ai" },
    );
    expect(redirectLocation(callback).toString()).toBe(
      `${redirectUri}/success`,
    );
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);

    await connectors.deleteCustomConnector(actor, connector.id);
  });

  it("replays an in-flight prefixed OAuth state and uses a plain nonce on reconnect", async () => {
    mockEnv("GET_STARTED_REWARDS_ROLLOUT", "all");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    await connectors.updateFeatureSwitches(actor, {});
    const connector = await createCustomOAuthConnector(actor, provider);
    const legacyRedirectUri = "https://app.okou.ai/connectors/custom/callback";
    const state = `okou.${randomBytes(32).toString("hex")}`;

    // Reproduce an authorization issued before new states became plain nonces.
    await seedCustomConnectorOAuthStateContext(context, {
      state,
      orgId: requiredOrgId(actor),
      userId: actor.userId,
      customConnectorId: connector.id,
      storageVersion: connector.storageVersion,
      redirectUri: legacyRedirectUri,
      oauthContext: {
        version: 2,
        authMode: "oauth",
        connectorId: connector.id,
        storageVersion: connector.storageVersion,
      },
    });

    const legacyCallback =
      await connectors.completeCustomConnectorOAuth2Callback(
        { code: "legacy-okou-code", state },
        { baseUrl: "https://api.okou.ai" },
      );
    expect(redirectLocation(legacyCallback).toString()).toBe(
      "https://app.okou.ai/connectors/custom/callback/success",
    );
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(
      legacyRedirectUri,
    );

    const [account] = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    if (!account) {
      throw new Error("Expected legacy OAuth callback to create an account");
    }
    const reconnectAuthorization = new URL(
      await connectors.startCustomConnectorOAuth2AtBaseUrl(
        actor,
        connector.id,
        "https://api.okou.ai",
        { intent: "reconnect", connectionId: account.id },
      ),
    );
    expect(authorizationState(reconnectAuthorization)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    const okouRedirectUri = "https://app.okou.ai/connectors/custom/callback";
    expect(reconnectAuthorization.searchParams.get("redirect_uri")).toBe(
      okouRedirectUri,
    );

    await connectors.completeCustomConnectorOAuth2Callback(
      {
        code: "reconnected-okou-code",
        state: authorizationState(reconnectAuthorization),
      },
      { baseUrl: "https://api.okou.ai" },
    );
    expect(provider.tokenBodies).toHaveLength(2);
    expect(provider.tokenBodies[1]?.get("redirect_uri")).toBe(okouRedirectUri);

    await connectors.deleteCustomConnector(actor, connector.id);
    expect(
      (await readGetStartedStatus(context, actor)).quests.find((q) => {
        return q.key === "connector";
      }),
    ).toMatchObject({ claimedCount: 1, earnedCredits: 100, canEarnMore: true });
  });
});
