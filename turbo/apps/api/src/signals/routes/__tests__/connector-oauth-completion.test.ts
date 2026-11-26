import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
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

const githubTarget: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "github",
});

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

async function startDeniedReconnect() {
  mockGitHubConnectorOAuth();
  const owner = bdd.user();
  const addAttemptId = await connectGithub(owner);
  const added = await readReceipt(owner, addAttemptId, githubTarget);
  if (!("connectionId" in added.body)) {
    throw new Error("Expected the GitHub add receipt");
  }
  const connectionId = added.body.connectionId;
  const reconnect = { intent: "reconnect", connectionId } as const;
  const denied = await connectors.startOauth(
    owner,
    "github",
    "oauth",
    reconnect,
  );
  return {
    owner,
    connectionId,
    reconnect,
    deniedAttemptId: denied.oauthAttemptId,
    deniedState: stateOf(denied.authorizationUrl),
  };
}

type DeniedReconnect = Awaited<ReturnType<typeof startDeniedReconnect>>;

async function renameAndSelectDefault(attempt: DeniedReconnect) {
  await renameAccount(
    attempt.owner,
    attempt.connectionId,
    githubTarget,
    "Work GitHub",
  );
  await connectors.setDefaultBuiltinConnectorAccount(
    attempt.owner,
    "github",
    attempt.connectionId,
  );
}

async function denyReconnectAfterAccountEdits() {
  const attempt = await startDeniedReconnect();
  await renameAndSelectDefault(attempt);
  const denied = await connectors.completeOauthCallbackResult("github", {
    state: attempt.deniedState,
    error: "access_denied",
  });
  if (denied.body.status !== "error") {
    throw new Error("Expected the provider denial to fail the reconnect");
  }
  return attempt;
}

async function completeRetry(attempt: DeniedReconnect) {
  const retry = await connectors.startOauth(
    attempt.owner,
    "github",
    "oauth",
    attempt.reconnect,
  );
  const result = await connectors.completeOauthCallbackResult("github", {
    state: stateOf(retry.authorizationUrl),
    code: `code-${randomUUID()}`,
  });
  return { retryAttemptId: retry.oauthAttemptId, status: result.body.status };
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
  it("connector-oauth-completion-002 (1/3) reports a denied reconnect as an error without a receipt after a rename and default change", async () => {
    const attempt = await startDeniedReconnect();

    await renameAndSelectDefault(attempt);
    await expectMissingReceipt(
      attempt.owner,
      attempt.deniedAttemptId,
      githubTarget,
    );

    const denied = await connectors.completeOauthCallbackResult("github", {
      state: attempt.deniedState,
      error: "access_denied",
    });
    expect(denied.body.status).toBe("error");
    await expectMissingReceipt(
      attempt.owner,
      attempt.deniedAttemptId,
      githubTarget,
    );
  });

  it("connector-oauth-completion-002 (2/3) returns the separate retry's receipt while the denied attempt stays missing", async () => {
    const attempt = await denyReconnectAfterAccountEdits();

    const retry = await completeRetry(attempt);
    expect(retry.status).toBe("success");
    const retried = await readReceipt(
      attempt.owner,
      retry.retryAttemptId,
      githubTarget,
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toStrictEqual({ connectionId: attempt.connectionId });
    await expectMissingReceipt(
      attempt.owner,
      attempt.deniedAttemptId,
      githubTarget,
    );
  });

  it("connector-oauth-completion-002 (3/3) rejects a successful callback replayed with the denied attempt's state", async () => {
    const attempt = await denyReconnectAfterAccountEdits();
    const retry = await completeRetry(attempt);
    if (retry.status !== "success") {
      throw new Error("Expected the separate retry to succeed");
    }

    const replay = await connectors.completeOauthCallbackResult("github", {
      state: attempt.deniedState,
      code: `code-${randomUUID()}`,
    });
    expect(replay.body.status).toBe("error");
    await expectMissingReceipt(
      attempt.owner,
      attempt.deniedAttemptId,
      githubTarget,
    );
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

  it("connector-oauth-completion-001 (1/2) shows the GitHub receipt only to its owner and exact target", async () => {
    const { owner, attemptId, account } = await completedGithubAdd();
    const colleague = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const elsewhere = bdd.user({ userId: owner.userId });

    const receipt = await readReceipt(owner, attemptId, githubTarget);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get("cache-control")).toBe("no-store");
    expect(receipt.body).toStrictEqual({ connectionId: account.id });

    const unknown = await expectMissingReceipt(
      owner,
      randomUUID(),
      githubTarget,
    );
    await expect(
      expectMissingReceipt(owner, attemptId, {
        kind: "builtin",
        connectorSlug: "gitlab",
      }),
    ).resolves.toStrictEqual(unknown);
    await expect(
      expectMissingReceipt(colleague, attemptId, githubTarget),
    ).resolves.toStrictEqual(unknown);
    await expect(
      expectMissingReceipt(elsewhere, attemptId, githubTarget),
    ).resolves.toStrictEqual(unknown);
    const anonymous = await readReceipt(null, attemptId, githubTarget);
    expect(anonymous.status).toBe(401);
  });

  it("connector-oauth-completion-001 (2/2) keeps the receipt on retry and removes it with the account", async () => {
    const { owner, attemptId, account } = await completedGithubAdd();

    const retried = await readReceipt(owner, attemptId, githubTarget);
    expect(retried.status).toBe(200);
    expect(retried.body).toStrictEqual({ connectionId: account.id });

    server.use(
      http.delete(
        "https://api.github.com/applications/github-client-id/grant",
        () => {
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await connectors.deleteBuiltinConnectorAccount(owner, "github", account.id);
    await expectMissingReceipt(owner, attemptId, githubTarget);
  });
});

/** An owner whose GitHub OAuth add attempt completed with one account. */
async function completedGithubAdd() {
  mockGitHubConnectorOAuth();
  const owner = bdd.user();
  const attemptId = await connectGithub(owner);
  const account = await connectors.readDefaultBuiltinAccount(owner, "github");
  return { owner, attemptId, account };
}
