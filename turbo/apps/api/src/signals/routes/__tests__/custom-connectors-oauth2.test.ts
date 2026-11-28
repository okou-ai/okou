import { randomUUID } from "node:crypto";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { connectorAccountRoutes } from "../connector-accounts";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const APP_CALLBACK = "https://app.okou.ai/connectors/custom/callback";

type Provider = ReturnType<typeof mockCustomConnectorOAuth2Provider>;

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function useHostedOrigins() {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
}

async function createStaticOAuthConnector(
  owner: ApiTestUser,
  provider: Provider,
  options: {
    readonly clientId?: string;
    readonly authorizationParams?: Readonly<Record<string, string>>;
  } = {},
) {
  return await connectors.createCustomConnector(owner, {
    displayName: "Static OAuth",
    prefixTemplates: [`https://static-${randomUUID()}.example.test/`],
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
      clientId: options.clientId ?? "static-client-id",
      clientSecret: "static-client-secret",
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: { ...options.authorizationParams },
    },
  });
}

function oauthClient() {
  return setupApp({ context, routes: customConnectorOAuth2Routes })(
    customConnectorOAuth2Contract,
  );
}

async function startAuthorization(
  owner: ApiTestUser,
  connectorId: string,
  native = false,
) {
  const response = await accept(
    oauthClient().start({
      params: { id: connectorId },
      headers: {
        ...signIn(owner),
        ...(native
          ? { "x-okou-native-connector-callback": "ios-https" as const }
          : {}),
      },
      body: { account: { intent: "add" } },
    }),
    [200],
  );
  if (response.body.result !== "authorization") {
    throw new Error("Expected a custom OAuth authorization redirect");
  }
  return response.body;
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

describe("Custom connector OAuth callbacks", () => {
  it("custom-connectors-oauth2-003 lists the editable OAuth configuration without the client secret", async () => {
    const provider = mockCustomConnectorOAuth2Provider(context);
    const owner = bdd.user();
    const created = await createStaticOAuthConnector(owner, provider, {
      authorizationParams: {
        audience: "https://static-api.example.test",
        prompt: "consent",
      },
    });

    const listed = await connectors.listCustomConnectors(owner);
    const detail = await connectors.readCustomConnector(owner, created.id);

    expect(
      listed.find((connector) => {
        return connector.id === created.id;
      }),
    ).toStrictEqual(detail);
    expect(detail).toMatchObject({
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "static-client-id",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {
          audience: "https://static-api.example.test",
          prompt: "consent",
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain("static-client-secret");
  });

  it("custom-connectors-oauth2-001 returns a consented attempt to iOS", async () => {
    useHostedOrigins();
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const owner = bdd.user();
    const connector = await createStaticOAuthConnector(owner, provider);

    const started = await startAuthorization(owner, connector.id, true);
    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(started.authorizationUrl),
        code: `code-${randomUUID()}`,
      });
    const receipt = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).oauthCompletion({
        headers: signIn(owner),
        params: { attemptId: started.oauthAttemptId },
        query: { kind: "custom", customConnectorId: connector.id },
      }),
      [200],
    );

    expect(started.nativeCallbackUrl).toBe(
      `https://app.okou.ai/native/connector-authorization?attemptId=${started.oauthAttemptId}`,
    );
    expect(callback.body).toMatchObject({
      status: "success",
      nativeAppReturn: {
        platform: "ios",
        attemptId: started.oauthAttemptId,
        httpsHost: "app.okou.ai",
      },
    });
    expect(receipt.status).toBe(200);
  });

  it("custom-connectors-oauth2-004 uses the Okou App callback for authorization and token exchange", async () => {
    useHostedOrigins();
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const owner = bdd.user();
    const connector = await createStaticOAuthConnector(owner, provider);

    const started = await startAuthorization(owner, connector.id);
    const authorization = new URL(started.authorizationUrl);
    const callback = await connectors.completeCustomConnectorOAuth2Callback(
      { state: stateOf(started.authorizationUrl), code: "consented-code" },
      { baseUrl: "https://api.okou.ai" },
    );
    const accounts = await connectors.listCustomConnectorAccounts(
      owner,
      connector.id,
    );

    expect(authorization.searchParams.get("redirect_uri")).toBe(APP_CALLBACK);
    expect(authorization.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/u);
    expect(callback.headers.get("location")).toBe(`${APP_CALLBACK}/success`);
    expect(
      provider.tokenBodies.map((body) => {
        return body.get("redirect_uri");
      }),
    ).toStrictEqual([APP_CALLBACK]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
    });
  });

  it("custom-connectors-oauth2-005 stores the verified OIDC identity of the grant", async () => {
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
      identity: {
        subject: "verified-subject-1",
        tokenUsername: "token-name",
        tokenEmail: "token@example.test",
        userInfoUsername: "userinfo-name",
        userInfoEmail: "userinfo@example.test",
      },
    });
    const owner = bdd.user();
    const connector = await createStaticOAuthConnector(owner, provider, {
      clientId: "branded-oauth-client-id",
    });

    const started = await startAuthorization(owner, connector.id);
    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(started.authorizationUrl),
        code: `code-${randomUUID()}`,
      });
    const accounts = await connectors.listCustomConnectorAccounts(
      owner,
      connector.id,
    );

    expect(new URL(started.authorizationUrl).searchParams.get("scope")).toBe(
      "read",
    );
    expect(callback.body.status).toBe("success");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      externalId: "verified-subject-1",
      externalUsername: "userinfo-name",
      externalEmail: "userinfo@example.test",
      oauthScopes: ["read"],
    });
  });
});
