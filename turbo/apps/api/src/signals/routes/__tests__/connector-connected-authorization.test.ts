import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const agentsApi = createAuthOrgAgentsBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function oauthState(start: { readonly authorizationUrl: string }): string {
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function githubReceipt(actor: ApiTestUser, attemptId: string) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  return await accept(
    client.oauthCompletion({
      headers: { authorization: "Bearer clerk-session" },
      params: { attemptId },
      query: { kind: "builtin", connectorSlug: "github" },
    }),
    [200, 404],
  );
}

function expectMissingReceipt(
  result: Awaited<ReturnType<typeof githubReceipt>>,
) {
  expect(result.status).toBe(404);
  expect(result.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "OAuth completion not found" },
  });
  expect(result.headers.get("cache-control")).toBe("no-store");
}

describe("Connected connector agent authorization", () => {
  it("authorizes the actual default agent rather than another available agent", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const { body } = await agentsApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Default Connected Connector Agent",
    });
    const decoy = await agentsApi.createAgent(actor, {
      displayName: "Nondefault Connected Connector Agent",
    });
    expect(decoy.agentId).not.toBe(body.agentId);
    const defaultGrants = await agentsApi.readEnabledConnectorSlugs(
      actor,
      body.agentId,
    );
    const decoyGrants = await agentsApi.readEnabledConnectorSlugs(
      actor,
      decoy.agentId,
    );

    const account = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "default-resolution-token" },
    );
    const authorized = await agentsApi.readEnabledConnectorSlugs(
      actor,
      body.agentId,
    );
    expect([...authorized].sort()).toStrictEqual(
      [...new Set([...defaultGrants, "openai"])].sort(),
    );
    await expect(
      agentsApi.readEnabledConnectorSlugs(actor, decoy.agentId),
    ).resolves.toStrictEqual(decoyGrants);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "openai"),
    ).resolves.toMatchObject({ id: account.id, connectionStatus: "connected" });
    expect(JSON.stringify(account)).not.toContain("default-resolution-token");

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "openai",
      account.id,
    );
    await bdd.deleteAgent(actor, decoy.agentId);
  });

  it("persists a connection without selecting an unrelated agent when no default has been configured", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    // Agent list and onboarding status intentionally bootstrap a default; omit them here.
    const unrelated = await agentsApi.createAgent(actor, {
      displayName: "Agent Without Default Bootstrap",
    });
    const grants = await agentsApi.readEnabledConnectorSlugs(
      actor,
      unrelated.agentId,
    );

    const account = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "no-default-resolution-token" },
    );
    await expect(
      connectorsApi.readConnectorBySlug(actor, "openai"),
    ).resolves.toMatchObject({ id: account.id, connectionStatus: "connected" });
    await expect(
      agentsApi.readEnabledConnectorSlugs(actor, unrelated.agentId),
    ).resolves.toStrictEqual(grants);
    expect(JSON.stringify(account)).not.toContain(
      "no-default-resolution-token",
    );

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "openai",
      account.id,
    );
    await bdd.deleteAgent(actor, unrelated.agentId);
  });

  it("does not substitute the default after an explicit OAuth target is deleted and permits exact-account retry", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const { body } = await agentsApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Surviving Default During Consent",
    });
    const target = await agentsApi.createAgent(actor, {
      displayName: "Explicit Agent Deleted During Consent",
    });
    const survivor = await agentsApi.createAgent(actor, {
      displayName: "Explicit Agent For Reconnect",
    });
    const defaultGrants = await agentsApi.readEnabledConnectorSlugs(
      actor,
      body.agentId,
    );
    const survivorGrants = await agentsApi.readEnabledConnectorSlugs(
      actor,
      survivor.agentId,
    );
    mockGitHubConnectorOAuth({ userId: 38_426, login: "post-connect-account" });
    const started = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
      target.agentId,
    );
    await bdd.deleteAgent(actor, target.agentId);
    const rejected = await connectorsApi.completeOauthCallbackResult("github", {
      code: "deleted-explicit-target",
      state: oauthState(started),
    });
    expect(rejected.body).toStrictEqual({
      status: "error",
      message: `Agent not found: ${target.agentId}`,
    });
    const persisted = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(persisted.connectionStatus).toBe("connected");
    expect(JSON.stringify(persisted)).not.toContain("github-access-");
    await expect(
      agentsApi.readEnabledConnectorSlugs(actor, body.agentId),
    ).resolves.toStrictEqual(defaultGrants);
    await expect(
      agentsApi.readEnabledConnectorSlugs(actor, survivor.agentId),
    ).resolves.toStrictEqual(survivorGrants);
    expectMissingReceipt(await githubReceipt(actor, started.oauthAttemptId));

    const retried = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
      survivor.agentId,
      { intent: "reconnect", connectionId: persisted.id },
    );
    const completed = await connectorsApi.completeOauthCallbackResult(
      "github",
      {
        code: "surviving-explicit-target",
        state: oauthState(retried),
      },
    );
    expect(completed.body).toStrictEqual({
      status: "success",
      username: "post-connect-account",
    });
    const authorized = await agentsApi.readEnabledConnectorSlugs(
      actor,
      survivor.agentId,
    );
    expect([...authorized].sort()).toStrictEqual(
      [...new Set([...survivorGrants, "github"])].sort(),
    );
    await expect(
      agentsApi.readEnabledConnectorSlugs(actor, body.agentId),
    ).resolves.toStrictEqual(defaultGrants);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toMatchObject({
      id: persisted.id,
      connectionStatus: "connected",
    });
    const accounts = await connectorsApi.listBuiltinConnectors(actor);
    expect(accounts.connectors).toHaveLength(1);
    const receipt = await githubReceipt(actor, retried.oauthAttemptId);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toStrictEqual({ connectionId: persisted.id });
    expect(receipt.headers.get("cache-control")).toBe("no-store");
    expectMissingReceipt(await githubReceipt(actor, started.oauthAttemptId));

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "github",
      persisted.id,
    );
    await bdd.deleteAgent(actor, survivor.agentId);
  });
});
