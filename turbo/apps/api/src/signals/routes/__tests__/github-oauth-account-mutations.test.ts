import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockGitHubConnectorOAuth } from "./helpers/api-bdd-connectors";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });

const context = testContext();
const oauthStart = setupApp({ context, routes: builtinConnectorsRoutes })(
  builtinConnectorOauthStartContract,
);
const oauthCallback = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);

function signIn(actor: ApiTestUser): void {
  if (!actor.orgId) {
    throw new Error("Expected a workspace member");
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "GitHub",
    },
  ]);
}

async function connectGithub(
  actor: ApiTestUser,
  identity: { readonly userId: number; readonly login: string },
  account: ConnectorAccountMutationIntent,
): Promise<void> {
  mockGitHubConnectorOAuth(identity);
  signIn(actor);
  const started = await accept(
    oauthStart.start({
      headers: AUTH_HEADERS,
      params: { connectorSlug: "github" },
      body: { authMethod: "oauth", account },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected a GitHub authorization state");
  }
  const callback = await accept(
    oauthCallback.callback({
      headers: {},
      params: { connectorSlug: "github" },
      query: {
        code: `code-${identity.userId}`,
        state,
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(callback.body.status).toBe("success");
}

async function listGithubAccounts(actor: ApiTestUser) {
  signIn(actor);
  const response = await accept(
    accounts.connections({
      headers: AUTH_HEADERS,
      query: { kind: "builtin", connectorSlug: "github" },
    }),
    [200],
  );
  return response.body.connections;
}

async function connectFirstAndSecond(member: ApiTestUser) {
  await connectGithub(
    member,
    { userId: 101, login: "github-first" },
    { intent: "add", displayName: "First" },
  );
  await connectGithub(
    member,
    { userId: 202, login: "github-second" },
    { intent: "add", displayName: "Second" },
  );
  const before = await listGithubAccounts(member);
  const first = before.find((account) => {
    return account.externalId === "101";
  });
  const second = before.find((account) => {
    return account.externalId === "202";
  });
  if (!first || !second) {
    throw new Error("Expected both initial GitHub accounts");
  }
  return { before, firstId: first.id, secondId: second.id };
}

test("github-oauth-account-mutations-005 keeps the same GitHub identity separate per workspace", async () => {
  const bdd = createBddApi(context);
  const first = bdd.user();
  const second = bdd.user();
  await connectGithub(
    first,
    { userId: 304, login: "github-shared" },
    { intent: "add", displayName: "First owner" },
  );
  await connectGithub(
    second,
    { userId: 304, login: "github-shared" },
    { intent: "add", displayName: "Second owner" },
  );

  const firstAccounts = await listGithubAccounts(first);
  const secondAccounts = await listGithubAccounts(second);

  expect(firstAccounts).toStrictEqual([
    expect.objectContaining({
      externalId: "304",
      displayName: "First owner",
      isDefault: true,
    }),
  ]);
  expect(secondAccounts).toStrictEqual([
    expect.objectContaining({
      externalId: "304",
      displayName: "Second owner",
      isDefault: true,
    }),
  ]);
  expect(secondAccounts[0]?.id).not.toBe(firstAccounts[0]?.id);
});

test("github-oauth-account-mutations-003 (1/2) lists both connected GitHub accounts before the refresh", async () => {
  const member = createBddApi(context).user();
  const { before } = await connectFirstAndSecond(member);

  expect(before).toHaveLength(2);
  expect(before).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ externalId: "101" }),
      expect.objectContaining({ externalId: "202" }),
    ]),
  );
});

test("github-oauth-account-mutations-003 (2/2) refreshes the existing sibling account on add", async () => {
  const member = createBddApi(context).user();
  const { firstId, secondId } = await connectFirstAndSecond(member);

  await connectGithub(
    member,
    { userId: 202, login: "github-second-updated" },
    { intent: "add", displayName: "Ignored on refresh" },
  );
  const after = await listGithubAccounts(member);

  expect(after).toHaveLength(2);
  expect(after).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstId,
        externalId: "101",
        displayName: "First",
        externalUsername: "github-first",
        isDefault: true,
      }),
      expect.objectContaining({
        id: secondId,
        externalId: "202",
        displayName: "Second",
        externalUsername: "github-second-updated",
        isDefault: false,
      }),
    ]),
  );
});
