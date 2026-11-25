import { randomUUID } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();

const GITHUB_SCOPES = ["repo", "project", "workflow"];

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
      granted.body.connectionId,
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
});
