import { randomBytes, randomUUID } from "node:crypto";

import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { feishuOauthRoutes } from "../feishu-oauth";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const connectors = createConnectorBddApi(context);
const callback = setupApp({ context, routes: feishuOauthRoutes })(
  feishuOauthContract,
);

async function requestPreview(state?: string) {
  return await accept(
    callback.callback({
      query: { code: "preview-code", state, responseMode: "json" },
    }),
    [400],
  );
}

describe("Custom OAuth state preview", () => {
  const ownedConnectors: {
    readonly actor: ApiTestUser;
    readonly connectorId: string;
  }[] = [];

  afterEach(async () => {
    for (const { actor, connectorId } of ownedConnectors.splice(0)) {
      await connectors.deleteCustomConnector(actor, connectorId);
    }
  });

  it("rejects missing, empty and unknown nonces through the Feishu callback", async () => {
    for (const state of [undefined, "", randomBytes(32).toString("hex")]) {
      const response = await requestPreview(state);
      expect(response.body).toStrictEqual({
        error: "Invalid or expired connect state",
      });
    }
  });

  it("preserves a standard OAuth nonce rejected by the Feishu callback until its own completion", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await connectors.createCustomConnector(actor, {
      displayName: `Preview OAuth ${randomUUID()}`,
      prefixTemplates: [`https://${randomUUID()}.preview.example.test/v1/`],
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
        clientSecret: "preview-oauth-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });

    ownedConnectors.push({ actor, connectorId: connector.id });
    const authorizationUrl = new URL(
      await connectors.startCustomConnectorOAuth2(actor, connector.id),
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected the public OAuth start to return a nonce");
    }
    expect(state).toMatch(/^[0-9a-f]{64}$/u);

    const rejected = await requestPreview(state);
    expect(rejected.body).toStrictEqual({
      error: "Invalid or expired connect state",
    });
    expect(provider.tokenBodies).toHaveLength(0);
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([]);

    const completed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "standard-completion-code",
        state,
      });
    expect(completed.body).toStrictEqual({
      status: "success",
      username: null,
    });
    const accounts = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      target: { kind: "custom", customConnectorId: connector.id },
      authMethod: "oauth",
      connectionStatus: "connected",
    });
    expect(provider.tokenBodies).toHaveLength(1);

    const replayed = await requestPreview(state);
    expect(replayed.body).toStrictEqual({
      error: "Invalid or expired connect state",
    });
    expect(provider.tokenBodies).toHaveLength(1);
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual(accounts);
  });
});
