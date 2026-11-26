import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function connectGithub(actor: ApiTestUser) {
  const started = await connectors.startOauth(actor, "github", "oauth");
  const result = await connectors.completeOauthCallbackResult("github", {
    state: stateOf(started.authorizationUrl),
    code: `code-${randomUUID()}`,
  });
  expect(result.body.status).toBe("success");
  return await connectors.readDefaultBuiltinAccount(actor, "github");
}

function reconnect(connectionId: string) {
  return { intent: "reconnect" as const, connectionId };
}

test("connectors-oauth-reconnect-start-001 hides another member's account from reconnect", async () => {
  mockGitHubConnectorOAuth();
  const owner = bdd.user({ orgRole: "org:member" });
  const colleague = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
  const account = await connectGithub(owner);
  const before = await connectors.listBuiltinConnectorAccounts(owner, "github");

  const rejected = await connectors.requestOauthStart(
    colleague,
    "github",
    "oauth",
    { statuses: [404], account: reconnect(account.id) },
  );

  expect(rejected.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "Connector account not found" },
  });
  await expect(
    connectors.listBuiltinConnectorAccounts(owner, "github"),
  ).resolves.toStrictEqual(before);
  await expect(
    connectors.listBuiltinConnectorAccounts(colleague, "github"),
  ).resolves.toStrictEqual([]);
});

test("connectors-oauth-reconnect-start-004 reconnects the exact owned account", async () => {
  mockGitHubConnectorOAuth({ userId: 39_076 });
  const owner = bdd.user({ orgRole: "org:member" });
  const account = await connectGithub(owner);
  const before = await connectors.listBuiltinConnectorAccounts(owner, "github");

  const started = await connectors.startOauth(
    owner,
    "github",
    "oauth",
    reconnect(account.id),
  );
  expect(started.connectionId).toBeUndefined();
  expect(started.oauthAttemptId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await expect(
    connectors.listBuiltinConnectorAccounts(owner, "github"),
  ).resolves.toStrictEqual(before);

  const completed = await connectors.completeOauthCallbackResult("github", {
    state: stateOf(started.authorizationUrl),
    code: `code-${randomUUID()}`,
  });
  expect(completed.body.status).toBe("success");
  const after = await connectors.listBuiltinConnectorAccounts(owner, "github");
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    id: account.id,
    externalId: "39076",
    isDefault: true,
  });
});

async function deleteDuringReconnectConsent(owner: ApiTestUser) {
  server.use(
    http.delete(
      "https://api.github.com/applications/github-client-id/grant",
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const account = await connectGithub(owner);
  const started = await connectors.startOauth(
    owner,
    "github",
    "oauth",
    reconnect(account.id),
  );
  await connectors.deleteBuiltinConnectorAccount(owner, "github", account.id);
  return await connectors.completeOauthCallbackResult("github", {
    state: stateOf(started.authorizationUrl),
    code: `code-${randomUUID()}`,
  });
}

test("connectors-oauth-reconnect-start-005 (1/2) rejects the reconnect callback after the account is deleted", async () => {
  mockGitHubConnectorOAuth();
  const owner = bdd.user({ orgRole: "org:member" });

  const completed = await deleteDuringReconnectConsent(owner);

  expect(completed.body).toStrictEqual({
    status: "error",
    message: "Connector account not found",
  });
});

test("connectors-oauth-reconnect-start-005 (2/2) keeps the github account list empty after the rejected callback", async () => {
  mockGitHubConnectorOAuth();
  const owner = bdd.user({ orgRole: "org:member" });
  await deleteDuringReconnectConsent(owner);

  await expect(
    connectors.listBuiltinConnectorAccounts(owner, "github"),
  ).resolves.toStrictEqual([]);
});
