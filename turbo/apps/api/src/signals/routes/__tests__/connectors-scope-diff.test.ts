import { randomUUID } from "node:crypto";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function accountClient(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function requestAccountScopeDiff(
  actor: ApiTestUser,
  connectionId: string,
  connectorSlug: ConnectorSlug = "github",
) {
  return await accept(
    accountClient(actor).scopeDiff({
      headers: authHeaders(),
      params: { connectionId },
      query: { connectorSlug },
    }),
    [200, 404],
  );
}

function cleanupAccount(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
  connectionId: string,
) {
  onTestFinished(async () => {
    await accept(
      accountClient(actor).delete({
        headers: authHeaders(),
        params: { connectionId },
        body: { target: { kind: "builtin", connectorSlug } },
      }),
      [200, 404],
    );
  });
}

// Mirrors `github.ts` connector OAuth scopes; deterministic so the
// `toStrictEqual` assertions catch any silent payload drift if the
// canonical scope list changes upstream.
//
// Historical missing/stale OAuth scope rows are not built here: the public
// OAuth callback stores the currently requested scope set, so arbitrary old
// scope snapshots are not externally constructible through the API.
const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function connectGithub(actor: ApiTestUser, userId = 42): Promise<string> {
  mockGitHubConnectorOAuth({ userId });
  const start = await connectorsApi.startOauth(actor, "github", "oauth");
  await connectorsApi.completeOauthCallback("github", {
    code: `github-${randomUUID()}`,
    state: stateFromAuthorizationUrl(start.authorizationUrl),
  });
  const receipt = await accept(
    accountClient(actor).oauthCompletion({
      headers: authHeaders(),
      params: { attemptId: start.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: "github" },
    }),
    [200],
  );
  cleanupAccount(actor, "github", receipt.body.connectionId);
  return receipt.body.connectionId;
}

describe("GET /api/connectors/:connectorSlug/scope-diff", () => {
  it("returns 401 when not authenticated", async () => {
    const response = await connectorsApi.requestScopeDiff(
      null,
      "github",
      [401],
    );
    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectorsApi.requestScopeDiff(
      actor,
      "github",
      [401],
    );
    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns an empty diff when stored scopes match current scopes exactly", async () => {
    const actor = bdd.user();
    const connectionId = await connectGithub(actor);

    const expected = {
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    };
    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual(expected);
    const exact = await requestAccountScopeDiff(actor, connectionId);
    expect(exact.status).toBe(200);
    expect(exact.body).toStrictEqual(expected);

    const missing = await requestAccountScopeDiff(actor, randomUUID());
    expect(missing.status).toBe(404);
    for (const unavailable of [
      await requestAccountScopeDiff(actor, connectionId, "openai"),
      await requestAccountScopeDiff(
        bdd.user({ userId: actor.userId }),
        connectionId,
      ),
      await requestAccountScopeDiff(
        bdd.user({ orgId: actor.orgId }),
        connectionId,
      ),
    ]) {
      expect(unavailable.status).toBe(404);
      expect(unavailable.body).toStrictEqual(missing.body);
    }
    const afterDenials = await requestAccountScopeDiff(actor, connectionId);
    expect(afterDenials.status).toBe(200);
    expect(afterDenials.body).toStrictEqual(expected);
  });

  it("reads the current default and exact accounts after default switching and deletion", async () => {
    const actor = bdd.user();
    const initiallyMissing = await connectorsApi.requestScopeDiff(
      actor,
      "github",
      [404],
    );
    expectApiError(initiallyMissing.body);
    expect(initiallyMissing.body.error.message).toBe("Connector not found");
    const firstId = await connectGithub(actor);
    const expected = {
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    };
    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual(expected);

    const secondId = await connectGithub(actor, 84);
    expect(secondId).not.toBe(firstId);
    const selected = await connectorsApi.setDefaultBuiltinConnectorAccount(
      actor,
      "github",
      secondId,
    );
    expect(selected).toMatchObject({ id: secondId, isDefault: true });
    for (const id of [firstId, secondId]) {
      const exact = await requestAccountScopeDiff(actor, id);
      expect(exact.status).toBe(200);
      expect(exact.body).toStrictEqual(expected);
    }
    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual(expected);

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "github",
      secondId,
    );
    expect((await requestAccountScopeDiff(actor, secondId)).status).toBe(404);
    const promoted = await accept(
      accountClient(actor).connection({
        headers: authHeaders(),
        params: { connectionId: firstId },
        query: { kind: "builtin", connectorSlug: "github" },
      }),
      [200],
    );
    expect(promoted.body).toMatchObject({ id: firstId, isDefault: true });
    const surviving = await requestAccountScopeDiff(actor, firstId);
    expect(surviving.status).toBe(200);
    expect(surviving.body).toStrictEqual(expected);
    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual(expected);

    await connectorsApi.deleteBuiltinConnectorAccount(actor, "github", firstId);
    const empty = await connectorsApi.requestScopeDiff(actor, "github", [404]);
    expect(empty.body).toStrictEqual(initiallyMissing.body);
    expect((await requestAccountScopeDiff(actor, firstId)).status).toBe(404);
  });

  it("returns an empty diff for manual auth connectors", async () => {
    const actor = bdd.user();
    const connected = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "sk-bdd-scope-diff" },
    );
    cleanupAccount(actor, "openai", connected.id);

    const expected = {
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    };
    await expect(
      connectorsApi.readScopeDiff(actor, "openai"),
    ).resolves.toStrictEqual(expected);
    const exact = await requestAccountScopeDiff(actor, connected.id, "openai");
    expect(exact.status).toBe(200);
    expect(exact.body).toStrictEqual(expected);
  });
});
