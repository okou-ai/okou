import { http, HttpResponse } from "msw";
import { expect, onTestFinished, test } from "vitest";

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

function mockGithubOAuth() {
  mockGitHubConnectorOAuth({ userId: 39_076, login: "reconnect-start" });
  server.use(
    http.delete(
      "https://api.github.com/applications/github-client-id/grant",
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
}

function state(authorizationUrl: string): string {
  const value = new URL(authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Expected GitHub OAuth state");
  }
  return value;
}

async function createAccount(actor: ApiTestUser) {
  mockGithubOAuth();
  const start = await connectors.startOauth(actor, "github", "oauth");
  const completed = await connectors.completeOauthCallbackResult("github", {
    code: "create-account",
    state: state(start.authorizationUrl),
  });
  expect(completed.body.status).toBe("success");
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "github",
  );
  expect(accounts).toHaveLength(1);
  const [account] = accounts;
  if (!account) {
    throw new Error("Expected the publicly created GitHub account");
  }
  expect(account.id).toBe(start.connectionId);
  onTestFinished(async () => {
    mockGithubOAuth();
    const remaining = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    for (const owned of remaining) {
      await connectors.deleteBuiltinConnectorAccount(actor, "github", owned.id);
    }
  });
  return account;
}

test.each(["other-user", "other-org"] as const)(
  "rejects a reconnect start for an account in %s scope",
  async (scope) => {
    const owner = bdd.user();
    const account = await createAccount(owner);
    const actor =
      scope === "other-user"
        ? bdd.user({ orgId: owner.orgId })
        : bdd.user({ userId: owner.userId });
    const response = await connectors.requestOauthStart(
      actor,
      "github",
      "oauth",
      {
        statuses: [404],
        account: { intent: "reconnect", connectionId: account.id },
      },
    );
    expect(response.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Connector account not found" },
    });
    await expect(
      connectors.listBuiltinConnectorAccounts(owner, "github"),
    ).resolves.toStrictEqual([account]);
    await expect(
      connectors.listBuiltinConnectorAccounts(actor, "github"),
    ).resolves.toStrictEqual([]);
  },
);

test("rejects a reconnect start for an account under another builtin target", async () => {
  const actor = bdd.user();
  const account = await createAccount(actor);
  const response = await connectors.requestOauthStart(
    actor,
    "test-oauth",
    "oauth",
    {
      statuses: [404],
      account: { intent: "reconnect", connectionId: account.id },
    },
  );
  expect(response.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "Connector account not found" },
  });
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "github"),
  ).resolves.toStrictEqual([account]);
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "test-oauth"),
  ).resolves.toStrictEqual([]);
});

test("starts and completes a reconnect for the exact owned account", async () => {
  const actor = bdd.user();
  const account = await createAccount(actor);
  const start = await connectors.startOauth(
    actor,
    "github",
    "oauth",
    undefined,
    {
      intent: "reconnect",
      connectionId: account.id,
    },
  );
  expect(start.connectionId).toBeUndefined();
  expect(start.oauthAttemptId).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "github"),
  ).resolves.toStrictEqual([account]);
  const completed = await connectors.completeOauthCallbackResult("github", {
    code: "reconnect-account",
    state: state(start.authorizationUrl),
  });
  expect(completed.body.status).toBe("success");
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "github"),
  ).resolves.toMatchObject([
    { id: account.id, externalId: "39076", isDefault: true },
  ]);
});

test("rejects reconnect completion after the account is deleted during consent", async () => {
  const actor = bdd.user();
  const account = await createAccount(actor);
  const start = await connectors.startOauth(
    actor,
    "github",
    "oauth",
    undefined,
    {
      intent: "reconnect",
      connectionId: account.id,
    },
  );
  await connectors.deleteBuiltinConnectorAccount(actor, "github", account.id);
  const completed = await connectors.completeOauthCallbackResult("github", {
    code: "deleted-account",
    state: state(start.authorizationUrl),
  });
  expect(completed.body).toStrictEqual({
    status: "error",
    message: "Connector account not found",
  });
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "github"),
  ).resolves.toStrictEqual([]);
});
