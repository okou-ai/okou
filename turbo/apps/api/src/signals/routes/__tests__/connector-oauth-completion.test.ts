import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

const githubTarget: ConnectorAccountTarget = {
  kind: "builtin",
  connectorSlug: "github",
};

async function readReceipt(
  actor: ApiTestUser | null,
  attemptId: string,
  target: ConnectorAccountTarget,
) {
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  if (actor) {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
  } else {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  }
  return await accept(
    client.oauthCompletion({
      headers: actor ? { authorization: "Bearer clerk-session" } : {},
      params: { attemptId },
      query: target,
    }),
    [200, 401, 404],
  );
}

async function expectMissingReceipt(
  actor: ApiTestUser,
  attemptId: string,
  target: ConnectorAccountTarget,
) {
  const response = await readReceipt(actor, attemptId, target);
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body).toMatchObject({
    error: { code: "NOT_FOUND", message: "OAuth completion not found" },
  });
  return response.body;
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function renameAccount(
  actor: ApiTestUser,
  connectionId: string,
  target: ConnectorAccountTarget,
  displayName: string,
) {
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const renamed = await accept(
    client.rename({
      headers: { authorization: "Bearer clerk-session" },
      params: { connectionId },
      body: { target, displayName },
    }),
    [200],
  );
  expect(renamed.body.displayName).toBe(displayName);
}

async function connectGithub(actor: ApiTestUser) {
  const started = await connectors.startOauth(actor, "github", "oauth");
  const state = stateOf(started.authorizationUrl);
  const result = await connectors.completeOauthCallbackResult("github", {
    state,
    code: `code-${randomUUID()}`,
  });
  expect(result.body.status).toBe("success");
  return started.oauthAttemptId;
}

async function startCustomOAuth(
  actor: ApiTestUser,
  connectorId: string,
  account: ConnectorAccountMutationIntent,
) {
  const response = await connectors.requestStartCustomConnectorOAuth2(
    actor,
    connectorId,
    [200],
    account,
  );
  if (response.status !== 200 || response.body.result !== "authorization") {
    throw new Error("Expected a custom OAuth authorization redirect");
  }
  return response.body;
}

describe("connector OAuth completion receipts", () => {
  it("connector-oauth-completion-002 keeps a denied reconnect without a receipt after account edits and a later retry", async () => {
    mockGitHubConnectorOAuth();
    const owner = bdd.user();
    await connectGithub(owner);
    const account = await connectors.readDefaultBuiltinAccount(owner, "github");
    const reconnect = {
      intent: "reconnect",
      connectionId: account.id,
    } as const;

    const denied = await connectors.startOauth(
      owner,
      "github",
      "oauth",
      reconnect,
    );
    const deniedState = stateOf(denied.authorizationUrl);
    await renameAccount(owner, account.id, githubTarget, "Work GitHub");
    await connectors.setDefaultBuiltinConnectorAccount(
      owner,
      "github",
      account.id,
    );
    await expectMissingReceipt(owner, denied.oauthAttemptId, githubTarget);

    const deniedResult = await connectors.completeOauthCallbackResult(
      "github",
      { state: deniedState, error: "access_denied" },
    );
    expect(deniedResult.body.status).toBe("error");
    await expectMissingReceipt(owner, denied.oauthAttemptId, githubTarget);

    const retry = await connectors.startOauth(
      owner,
      "github",
      "oauth",
      reconnect,
    );
    const retryResult = await connectors.completeOauthCallbackResult("github", {
      state: stateOf(retry.authorizationUrl),
      code: `code-${randomUUID()}`,
    });
    expect(retryResult.body.status).toBe("success");
    const retried = await readReceipt(
      owner,
      retry.oauthAttemptId,
      githubTarget,
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toStrictEqual({ connectionId: account.id });
    await expectMissingReceipt(owner, denied.oauthAttemptId, githubTarget);

    const replay = await connectors.completeOauthCallbackResult("github", {
      state: deniedState,
      code: `code-${randomUUID()}`,
    });
    expect(replay.body.status).toBe("error");
    await expectMissingReceipt(owner, denied.oauthAttemptId, githubTarget);
  });

  it("connector-oauth-completion-005 tracks a custom OAuth add and a cancelled reconnect independently", async () => {
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const owner = bdd.user();
    const connector = await connectors.createCustomConnector(owner, {
      displayName: "Receipt OAuth",
      prefixTemplates: ["https://receipt-api.example.test/"],
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
        clientId: "receipt-client-id",
        clientSecret: "receipt-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    const customTarget: ConnectorAccountTarget = {
      kind: "custom",
      customConnectorId: connector.id,
    };

    const add = await startCustomOAuth(owner, connector.id, { intent: "add" });
    await expectMissingReceipt(owner, add.oauthAttemptId, customTarget);
    const added = await connectors.completeCustomConnectorOAuth2CallbackResult({
      state: stateOf(add.authorizationUrl),
      code: `code-${randomUUID()}`,
    });
    expect(added.body.status).toBe("success");
    const accounts = await connectors.listCustomConnectorAccounts(
      owner,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    const connectionId = accounts[0]?.id ?? "";

    const receipt = await readReceipt(owner, add.oauthAttemptId, customTarget);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get("cache-control")).toBe("no-store");
    expect(receipt.body).toStrictEqual({ connectionId });
    await expectMissingReceipt(owner, add.oauthAttemptId, githubTarget);
    await expectMissingReceipt(owner, add.oauthAttemptId, {
      kind: "custom",
      customConnectorId: randomUUID(),
    });

    await renameAccount(owner, connectionId, customTarget, "Renamed receipt");
    const reconnect = await startCustomOAuth(owner, connector.id, {
      intent: "reconnect",
      connectionId,
    });
    const cancelled =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(reconnect.authorizationUrl),
        error: "access_denied",
      });
    expect(cancelled.body.status).toBe("error");
    await expectMissingReceipt(owner, reconnect.oauthAttemptId, customTarget);
    const stillAdded = await readReceipt(
      owner,
      add.oauthAttemptId,
      customTarget,
    );
    expect(stillAdded.body).toStrictEqual({ connectionId });

    await connectors.deleteCustomConnectorAccount(
      owner,
      connector.id,
      connectionId,
    );
    await expectMissingReceipt(owner, add.oauthAttemptId, customTarget);
  });
});
