import { randomUUID } from "node:crypto";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const GITHUB_SCOPES = Object.freeze(["repo", "project", "workflow"]);
const UNCHANGED = Object.freeze({
  addedScopes: Object.freeze([]),
  removedScopes: Object.freeze([]),
  currentScopes: GITHUB_SCOPES,
  storedScopes: GITHUB_SCOPES,
});

function makeUser(
  options: {
    readonly orgId?: string | null;
    readonly orgRole?: "org:admin" | "org:member";
  } = {},
): ApiTestUser {
  const userId = `user_${randomUUID()}`;
  const orgId = options.orgId ?? `org_${randomUUID()}`;
  return {
    userId,
    orgId,
    orgRole: options.orgRole ?? "org:admin",
    email: `${userId}@example.test`,
  };
}

function githubUserId(): number {
  return Number.parseInt(randomUUID().slice(0, 8), 16);
}

async function connectGithub(actor: ApiTestUser, login: string) {
  const userId = githubUserId();
  mockGitHubConnectorOAuth({ userId, login });
  const started = await connectors.startOauth(actor, "github", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected GitHub authorization state");
  }
  const completed = await connectors.completeOauthCallbackResult("github", {
    code: `code-${randomUUID()}`,
    state,
  });
  expect(completed.body.status).toBe("success");
  return { externalId: String(userId), login };
}

/** Two GitHub identities of one owner; the newer one is the default. */
async function givenTwoAccounts() {
  const owner = makeUser();
  const olderIdentity = await connectGithub(owner, `older-${randomUUID()}`);
  const newerIdentity = await connectGithub(owner, `newer-${randomUUID()}`);
  const accounts = await connectors.listBuiltinConnectorAccounts(
    owner,
    "github",
  );
  const idOf = (identity: { readonly externalId: string }) => {
    const account = accounts.find((candidate) => {
      return candidate.externalId === identity.externalId;
    });
    if (!account) {
      throw new Error("Expected the connected GitHub account");
    }
    return account.id;
  };
  const older = { id: idOf(olderIdentity), login: olderIdentity.login };
  const newer = { id: idOf(newerIdentity), login: newerIdentity.login };
  await connectors.setDefaultBuiltinConnectorAccount(owner, "github", newer.id);
  return { owner, older, newer };
}

function listConnections(
  owner: ApiTestUser,
  query: { readonly includeScopeMismatch?: "true"; readonly search?: string },
) {
  createRouteMocks(context).clerk.session(owner.userId, owner.orgId);
  return accept(
    setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    ).connections({
      headers: AUTH_HEADERS,
      query: { kind: "builtin", connectorSlug: "github", ...query },
    }),
    [200],
  );
}

function scopeDiff(
  actor: ApiTestUser,
  connectionId: string,
  connectorSlug: "github" | "gitlab" = "github",
) {
  return connectors.requestBuiltinAccountScopeDiff(
    actor,
    connectorSlug,
    connectionId,
    [200, 404],
  );
}

test("connector-catalog-immutable-002 (1/5) lists both accounts without scope mismatch and returns the current default", async () => {
  const { owner, newer } = await givenTwoAccounts();

  const plain = await listConnections(owner, {});

  expect(plain.body.defaultConnection?.id).toBe(newer.id);
  expect(plain.body.connections).toHaveLength(2);
  for (const account of plain.body.connections) {
    expect(account).not.toHaveProperty("scopeMismatch");
  }
});

test("connector-catalog-immutable-002 (2/5) reports no scope mismatch and keeps the default while searching the older account", async () => {
  const { owner, older, newer } = await givenTwoAccounts();

  const enriched = await listConnections(owner, {
    includeScopeMismatch: "true",
  });
  const searched = await listConnections(owner, {
    includeScopeMismatch: "true",
    search: older.login,
  });

  expect(enriched.body.defaultConnection).toMatchObject({
    id: newer.id,
    scopeMismatch: false,
  });
  expect(
    enriched.body.connections.map((account) => {
      return [account.id, account.scopeMismatch];
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      [older.id, false],
      [newer.id, false],
    ]),
  );
  expect(enriched.body.connections).toHaveLength(2);
  expect(
    searched.body.connections.map((account) => {
      return [account.id, account.scopeMismatch];
    }),
  ).toStrictEqual([[older.id, false]]);
  expect(searched.body.defaultConnection).toMatchObject({
    id: newer.id,
    scopeMismatch: false,
  });
});

test("connector-catalog-immutable-002 (3/5) keeps each exact scope diff unchanged across a default change", async () => {
  const { owner, older, newer } = await givenTwoAccounts();

  const olderDiff = await scopeDiff(owner, older.id);
  const newerDiff = await scopeDiff(owner, newer.id);
  await connectors.setDefaultBuiltinConnectorAccount(owner, "github", older.id);
  const newerAfterSwitch = await scopeDiff(owner, newer.id);

  for (const diff of [olderDiff, newerDiff, newerAfterSwitch]) {
    expect(diff.status).toBe(200);
    expect(diff.body).toStrictEqual(UNCHANGED);
  }
});

test("connector-catalog-immutable-002 (4/5) hides the account from a wrong slug and another user", async () => {
  const { owner, older, newer } = await givenTwoAccounts();
  await connectors.setDefaultBuiltinConnectorAccount(owner, "github", older.id);

  const wrongSlug = await scopeDiff(owner, newer.id, "gitlab");
  const otherUser = await scopeDiff(
    makeUser({ orgId: owner.orgId, orgRole: "org:member" }),
    newer.id,
  );

  expect(wrongSlug.status).toBe(404);
  expect(otherUser.status).toBe(404);
});

test("connector-catalog-immutable-002 (5/5) hides the account after deletion", async () => {
  const { owner, older, newer } = await givenTwoAccounts();
  await connectors.setDefaultBuiltinConnectorAccount(owner, "github", older.id);

  // GitHub acknowledges the grant revocation that deletion requests.
  server.use(
    http.delete(
      "https://api.github.com/applications/github-client-id/grant",
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  await connectors.deleteBuiltinConnectorAccount(owner, "github", newer.id);
  const deleted = await scopeDiff(owner, newer.id);

  expect(deleted.status).toBe(404);
});
