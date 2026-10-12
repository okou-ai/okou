import { readGetStartedStatus } from "./helpers/get-started";
import { randomUUID } from "node:crypto";

import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { afterEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

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

async function createCustomOAuthConnector(
  actor: ApiTestUser,
  provider: CustomOAuthProvider,
) {
  return await connectors.createCustomConnector(
    actor,
    customOAuthConnectorBody(provider),
  );
}

async function connectCustomOAuthConnector(
  actor: ApiTestUser,
  connectorId: string,
): Promise<void> {
  const authorizationUrl = new URL(
    await connectors.startCustomConnectorOAuth2AtBaseUrl(
      actor,
      connectorId,
      "https://api.okou.ai",
    ),
  );
  await connectors.completeCustomConnectorOAuth2Callback(
    {
      code: `${connectorId}-code`,
      state: authorizationState(authorizationUrl),
    },
    { baseUrl: "https://api.okou.ai" },
  );
}

async function readConnectorQuest(actor: ApiTestUser) {
  return (await readGetStartedStatus(context, actor)).quests.find((quest) => {
    return quest.key === "connector";
  });
}

describe("Custom connector OAuth callbacks", () => {
  const ownedConnectors: {
    readonly actor: ApiTestUser;
    readonly connectorId: string;
  }[] = [];

  afterEach(async () => {
    for (const { actor, connectorId } of ownedConnectors.splice(0)) {
      await createConnectorBddApi(context).deleteCustomConnector(
        actor,
        connectorId,
      );
      await flushWaitUntilForTest();
    }
  });

  it("uses the configured Okou App callback for authorization and token exchange", async () => {
    const apiOrigin = "https://api.okou.ai";
    const appOrigin = "https://app.okou.ai";
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createCustomOAuthConnector(actor, provider);
    ownedConnectors.push({ actor, connectorId: connector.id });
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
    const callback = await connectors.completeCustomConnectorOAuth2Callback(
      { code: `${actor.userId}-code`, state },
      { baseUrl: apiOrigin },
    );
    expect(redirectLocation(callback).toString()).toBe(
      `${callbackUri}/success`,
    );
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(callbackUri);
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toMatchObject([
      {
        target: { kind: "custom", customConnectorId: connector.id },
        authMethod: "oauth",
        connectionStatus: "connected",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
      },
    ]);
  });

  it("persists verified OIDC identity for a static custom OAuth grant", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
      identity: {
        subject: "static-custom-user-123",
        tokenUsername: "static-token-user",
        tokenEmail: "static-token-user@example.test",
        userInfoUsername: "static-userinfo-user",
        userInfoEmail: "static-userinfo-user@example.test",
      },
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createCustomOAuthConnector(actor, provider);
    const authorizationUrl = new URL(
      await connectors.startCustomConnectorOAuth2AtBaseUrl(
        actor,
        connector.id,
        "https://api.okou.ai",
      ),
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("read");

    await connectors.completeCustomConnectorOAuth2Callback(
      {
        code: "static-custom-identity-code",
        state: authorizationState(authorizationUrl),
      },
      { baseUrl: "https://api.okou.ai" },
    );

    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toMatchObject([
      {
        externalId: "static-custom-user-123",
        externalUsername: "static-userinfo-user",
        externalEmail: "static-userinfo-user@example.test",
        oauthScopes: ["read"],
      },
    ]);

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
    const owner = createPublicConnectorActor(context);
    const { actor, run: own } = owner;
    await own(async () => {
      const connector = await own(() => {
        return createCustomOAuthConnector(actor, provider);
      });
      const redirectUri = "https://app.okou.ai/connectors/custom/callback";
      const authorization = new URL(
        await own(() => {
          return connectors.startCustomConnectorOAuth2AtBaseUrl(
            actor,
            connector.id,
            "https://api.okou.ai",
          );
        }),
      );
      const state = authorizationState(authorization);
      expect(state).toMatch(/^[0-9a-f]{64}$/u);

      const callback = await own(() => {
        return connectors.completeCustomConnectorOAuth2Callback(
          { code: "canonical-okou-code", state },
          { baseUrl: "https://api.okou.ai" },
        );
      });
      expect(redirectLocation(callback).toString()).toBe(
        `${redirectUri}/success`,
      );
      expect(provider.tokenBodies).toHaveLength(1);
      expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);

      await own(() => {
        return connectors.deleteCustomConnector(actor, connector.id);
      });
    });
  });

  it("completes an in-flight OAuth authorization and uses a new plain nonce on reconnect", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const owner = createPublicConnectorActor(context);
    const { actor, run: own } = owner;
    await own(async () => {
      owner.ownsFeatureSwitches();
      await own(() => {
        return connectors.updateFeatureSwitches(actor, {});
      });
      const connector = await own(() => {
        return createCustomOAuthConnector(actor, provider);
      });
      const initialRedirectUri =
        "https://app.okou.ai/connectors/custom/callback";
      const authorization = new URL(
        await own(() => {
          return connectors.startCustomConnectorOAuth2AtBaseUrl(
            actor,
            connector.id,
            "https://api.okou.ai",
          );
        }),
      );
      const state = authorizationState(authorization);
      expect(state).toMatch(/^[0-9a-f]{64}$/u);

      const initialCallback = await own(() => {
        return connectors.completeCustomConnectorOAuth2Callback(
          { code: "initial-okou-code", state },
          { baseUrl: "https://api.okou.ai" },
        );
      });
      expect(redirectLocation(initialCallback).toString()).toBe(
        "https://app.okou.ai/connectors/custom/callback/success",
      );
      expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(
        initialRedirectUri,
      );

      const [account] = await own(() => {
        return connectors.listCustomConnectorAccounts(actor, connector.id);
      });
      if (!account) {
        throw new Error("Expected initial OAuth callback to create an account");
      }
      const reconnectAuthorization = new URL(
        await own(() => {
          return connectors.startCustomConnectorOAuth2AtBaseUrl(
            actor,
            connector.id,
            "https://api.okou.ai",
            { intent: "reconnect", connectionId: account.id },
          );
        }),
      );
      expect(authorizationState(reconnectAuthorization)).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      const okouRedirectUri = "https://app.okou.ai/connectors/custom/callback";
      expect(reconnectAuthorization.searchParams.get("redirect_uri")).toBe(
        okouRedirectUri,
      );

      await own(() => {
        return connectors.completeCustomConnectorOAuth2Callback(
          {
            code: "reconnected-okou-code",
            state: authorizationState(reconnectAuthorization),
          },
          { baseUrl: "https://api.okou.ai" },
        );
      });
      expect(provider.tokenBodies).toHaveLength(2);
      expect(provider.tokenBodies[1]?.get("redirect_uri")).toBe(
        okouRedirectUri,
      );

      await own(() => {
        return connectors.deleteCustomConnector(actor, connector.id);
      });
      expect(
        (
          await own(() => {
            return readGetStartedStatus(context, actor);
          })
        ).quests.find((q) => {
          return q.key === "connector";
        }),
      ).toMatchObject({
        claimedCount: 1,
        earnedCredits: 100,
        canEarnMore: true,
      });
    });
  });
});

describe("Custom connector Get Started reward", () => {
  it("awards custom connectors once per user across new and recreated connectors", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    await connectors.updateFeatureSwitches(actor, {});

    const first = await createCustomOAuthConnector(actor, provider);
    await connectCustomOAuthConnector(actor, first.id);
    await expect(readConnectorQuest(actor)).resolves.toMatchObject({
      claimedCount: 1,
      earnedCredits: 100,
    });

    // A second connector with the same provider credentials earns nothing.
    const second = await createCustomOAuthConnector(actor, provider);
    await connectCustomOAuthConnector(actor, second.id);
    await expect(readConnectorQuest(actor)).resolves.toMatchObject({
      claimedCount: 1,
      earnedCredits: 100,
    });

    // Deleting and recreating a connector does not reset eligibility.
    await connectors.deleteCustomConnector(actor, first.id);
    await connectors.deleteCustomConnector(actor, second.id);
    const recreated = await createCustomOAuthConnector(actor, provider);
    await connectCustomOAuthConnector(actor, recreated.id);
    await expect(readConnectorQuest(actor)).resolves.toMatchObject({
      claimedCount: 1,
      earnedCredits: 100,
    });

    await connectors.deleteCustomConnector(actor, recreated.id);
  });
});
