import { randomUUID } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function connectionIdOf(
  body: { readonly connectionId: string } | { readonly error: unknown },
): string {
  if (!("connectionId" in body)) {
    throw new Error(
      `Expected a connected account, received ${JSON.stringify(body)}`,
    );
  }
  return body.connectionId;
}

const GITHUB_SCOPES = Object.freeze(["repo", "project", "workflow"]);

function scopeDiffFor(
  actor: ApiTestUser,
  connectionId: string,
  connectorSlug: ConnectorSlug = "github",
) {
  return createConnectorBddApi(context).requestBuiltinAccountScopeDiff(
    actor,
    connectorSlug,
    connectionId,
    [200, 404],
  );
}

async function connectGithub(actor: ApiTestUser, githubUserId: number) {
  const connectors = createConnectorBddApi(context);
  mockGitHubConnectorOAuth({
    userId: githubUserId,
    login: `bdd-github-${githubUserId}`,
  });
  const started = await connectors.startOauth(actor, "github", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected GitHub authorization state");
  }
  await connectors.completeOauthCallback("github", {
    code: `code-${randomUUID()}`,
    state,
  });
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "github",
  );
  const account = accounts.find((candidate) => {
    return candidate.externalId === String(githubUserId);
  });
  if (!account) {
    throw new Error("Expected the connected GitHub account");
  }
  return account;
}

function uniqueGithubUserId(): number {
  return Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
}

describe("GET /api/connector-accounts/:connectionId/scope-diff", () => {
  it("connector-account-scope-diff-005 returns an empty diff for an OpenAI API-token account", async () => {
    const owner = createBddApi(context).user();
    const connectors = createConnectorBddApi(context);
    const granted = await connectors.requestManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: `sk-${randomUUID()}` },
      { statuses: [200] },
    );
    const empty = {
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    };

    await expect(
      connectors.readDefaultBuiltinScopeDiff(owner, "openai"),
    ).resolves.toStrictEqual(empty);
    const exact = await scopeDiffFor(
      owner,
      connectionIdOf(granted.body),
      "openai",
    );
    expect(exact.status).toBe(200);
    expect(exact.body).toStrictEqual(empty);
  });

  it("connector-account-scope-diff-003 reports no change for current GitHub scopes and hides it from other identities", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const account = await connectGithub(owner, uniqueGithubUserId());
    // The only GitHub account is the default, so its exact diff is the default diff.
    expect(account.isDefault).toBeTruthy();

    const unknown = await scopeDiffFor(owner, randomUUID());
    const wrongSlug = await scopeDiffFor(owner, account.id, "gitlab");
    const otherUser = await scopeDiffFor(
      bdd.user({ orgId: owner.orgId, orgRole: "org:member" }),
      account.id,
    );
    const otherOrg = await scopeDiffFor(
      bdd.user({ userId: owner.userId }),
      account.id,
    );
    const after = await scopeDiffFor(owner, account.id);

    const unchanged = {
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_SCOPES,
      storedScopes: GITHUB_SCOPES,
    };
    expect(after.status).toBe(200);
    expect(after.body).toStrictEqual(unchanged);
    expect(unknown.status).toBe(404);
    for (const rejected of [wrongSlug, otherUser, otherOrg]) {
      expect(rejected.status).toBe(404);
      expect(rejected.body).toStrictEqual(unknown.body);
    }
  });

  it("connector-account-scope-diff-004 (1/4) reads the missing, default and exact diffs of two GitHub accounts", async () => {
    const owner = createBddApi(context).user();
    const missing = await scopeDiffFor(owner, randomUUID());
    const { first, second } = await connectTwoGithubAccounts(owner);

    expect(missing.status).toBe(404);
    await expectAllUnchanged(owner, [first.id, second.id]);
  });

  it("connector-account-scope-diff-004 (2/4) switches the default to the second account and keeps every diff unchanged", async () => {
    const owner = createBddApi(context).user();
    const { first, second } = await connectTwoGithubAccounts(owner);

    const switched = await createConnectorBddApi(
      context,
    ).setDefaultBuiltinConnectorAccount(owner, "github", second.id);

    expect(switched).toMatchObject({ id: second.id, isDefault: true });
    await expectAllUnchanged(owner, [second.id, first.id]);
  });

  it("connector-account-scope-diff-004 (3/4) promotes the survivor after deleting the new default", async () => {
    const owner = createBddApi(context).user();
    const { first, second } = await connectTwoGithubAccounts(owner);
    await createConnectorBddApi(context).setDefaultBuiltinConnectorAccount(
      owner,
      "github",
      second.id,
    );

    const removed = await deleteGithubAccount(owner, second.id);

    expect(removed.promotedDefaultConnectionId).toBe(first.id);
    const deleted = await scopeDiffFor(owner, second.id);
    expect(deleted.status).toBe(404);
    await expectAllUnchanged(owner, [first.id]);
  });

  it("connector-account-scope-diff-004 (4/4) returns the original missing 404 after deleting the survivor", async () => {
    const owner = createBddApi(context).user();
    const missing = await scopeDiffFor(owner, randomUUID());
    const { first, second } = await connectTwoGithubAccounts(owner);
    await createConnectorBddApi(context).setDefaultBuiltinConnectorAccount(
      owner,
      "github",
      second.id,
    );
    await deleteGithubAccount(owner, second.id);

    const survivor = await deleteGithubAccount(owner, first.id);

    expect(survivor.promotedDefaultConnectionId).toBeNull();
    const gone = await scopeDiffFor(owner, first.id);
    expect(gone.status).toBe(404);
    expect(gone.body).toStrictEqual(missing.body);
  });
});

async function connectTwoGithubAccounts(owner: ApiTestUser) {
  const connectors = createConnectorBddApi(context);
  const [firstStart, secondStart] = await Promise.all([
    connectors.startOauth(owner, "github", "oauth"),
    connectors.startOauth(owner, "github", "oauth"),
  ]);
  const firstUserId = uniqueGithubUserId();
  const secondUserId = uniqueGithubUserId();
  for (const [githubUserId, started] of [
    [firstUserId, firstStart],
    [secondUserId, secondStart],
  ] as const) {
    mockGitHubConnectorOAuth({
      userId: githubUserId,
      login: `bdd-github-${githubUserId}`,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected GitHub authorization state");
    }
    await connectors.completeOauthCallback("github", {
      code: `code-${randomUUID()}`,
      state,
    });
  }
  const accounts = await connectors.listBuiltinConnectorAccounts(
    owner,
    "github",
  );
  const first = accounts.find((candidate) => {
    return candidate.externalId === String(firstUserId);
  });
  const second = accounts.find((candidate) => {
    return candidate.externalId === String(secondUserId);
  });
  if (!first || !second || first.id === second.id) {
    throw new Error("Expected two distinct connected GitHub accounts");
  }
  return { first, second };
}

async function expectAllUnchanged(
  owner: ApiTestUser,
  connectionIds: readonly string[],
) {
  const unchanged = {
    addedScopes: [],
    removedScopes: [],
    currentScopes: GITHUB_SCOPES,
    storedScopes: GITHUB_SCOPES,
  };
  const [defaultDiff, ...exact] = await Promise.all([
    createConnectorBddApi(context).readDefaultBuiltinScopeDiff(owner, "github"),
    ...connectionIds.map((connectionId) => {
      return scopeDiffFor(owner, connectionId);
    }),
  ]);
  expect(defaultDiff).toStrictEqual(unchanged);
  for (const diff of exact) {
    expect(diff.status).toBe(200);
    expect(diff.body).toStrictEqual(unchanged);
  }
}

async function deleteGithubAccount(owner: ApiTestUser, connectionId: string) {
  server.use(
    http.delete(
      "https://api.github.com/applications/github-client-id/grant",
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  createRouteMocks(context).clerk.session(
    owner.userId,
    owner.orgId,
    owner.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    ).delete({
      headers: { authorization: "Bearer clerk-session" },
      params: { connectionId },
      body: { target: { kind: "builtin", connectorSlug: "github" } },
    }),
    [200],
  );
  return response.body;
}
