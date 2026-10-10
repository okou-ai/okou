import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

async function prepareActor(): Promise<ApiTestUser> {
  const actor = bdd.user();
  mockTestOAuthDeviceConnectorProvider();
  onTestFinished(async () => {
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "test-oauth-device",
    );
    for (const account of accounts) {
      await connectorsApi.deleteBuiltinConnectorAccount(
        actor,
        "test-oauth-device",
        account.id,
      );
    }
    await connectorsApi.deleteFeatureSwitches(actor);
  });
  await connectorsApi.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.TestOauthConnector]: true,
  });
  return actor;
}

async function expectMissingSession(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const rejected = await connectorsApi.requestDeviceAuthPoll(
    actor,
    connectorSlug,
    sessionId,
    sessionToken,
    [404],
  );
  expect(rejected.status).toBe(404);
  expect(rejected.body).toStrictEqual({
    error: {
      code: "NOT_FOUND",
      message: "OAuth device authorization session not found",
    },
  });
}

async function completeSession(
  actor: ApiTestUser,
  session: { readonly sessionId: string; readonly sessionToken: string },
) {
  const completed = await connectorsApi.pollDeviceAuth(
    actor,
    "test-oauth-device",
    session.sessionId,
    session.sessionToken,
  );
  if (completed.status !== "complete") {
    throw new Error(`Expected completed device session: ${completed.status}`);
  }
  expect(completed.connector.connectionStatus).toBe("connected");
  const serialized = JSON.stringify(completed);
  expect(serialized).not.toContain(session.sessionToken);
  expect(serialized).not.toContain("test-device-access:");
  expect(serialized).not.toContain("test-device:");
  return completed;
}

describe("Builtin device-auth owned-session reads", () => {
  it("rejects each real-session identity boundary before and after completion", async () => {
    const actor = await prepareActor();
    const peer = bdd.user({ orgId: actor.orgId });
    const foreignOrg = bdd.user({ userId: actor.userId });
    expect(peer.userId).not.toBe(actor.userId);
    expect(foreignOrg.userId).toBe(actor.userId);
    expect(foreignOrg.orgId).not.toBe(actor.orgId);
    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const rejectionCases = [
      { actor, connectorSlug: "test-oauth-device", token: "wrong-token" },
      { actor, connectorSlug: "github", token: session.sessionToken },
      {
        actor: peer,
        connectorSlug: "test-oauth-device",
        token: session.sessionToken,
      },
      {
        actor: foreignOrg,
        connectorSlug: "test-oauth-device",
        token: session.sessionToken,
      },
    ] as const;

    for (const candidate of rejectionCases) {
      await expectMissingSession(
        candidate.actor,
        candidate.connectorSlug,
        session.sessionId,
        candidate.token,
      );
    }
    await expect(
      connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth-device"),
    ).resolves.toStrictEqual([]);

    const completed = await completeSession(actor, session);
    expect(completed.connector.authMethod).toBe("oauth");
    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth-device"),
    ).resolves.toMatchObject({ id: completed.connector.id });

    for (const candidate of rejectionCases) {
      await expectMissingSession(
        candidate.actor,
        candidate.connectorSlug,
        session.sessionId,
        candidate.token,
      );
    }
    await expect(completeSession(actor, session)).resolves.toMatchObject({
      connector: { id: completed.connector.id, authMethod: "oauth" },
    });
  });

  it("requires the exact token for each auth-method session and re-polls its exact account", async () => {
    const actor = await prepareActor();
    const oauth = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const api = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
    );
    expect(api.sessionId).not.toBe(oauth.sessionId);
    expect(api.sessionToken).not.toBe(oauth.sessionToken);
    await expectMissingSession(
      actor,
      "test-oauth-device",
      oauth.sessionId,
      api.sessionToken,
    );
    await expectMissingSession(
      actor,
      "test-oauth-device",
      api.sessionId,
      oauth.sessionToken,
    );
    await expect(
      connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth-device"),
    ).resolves.toStrictEqual([]);

    const apiCompleted = await completeSession(actor, api);
    const oauthCompleted = await completeSession(actor, oauth);
    expect(apiCompleted.connector.authMethod).toBe("api");
    expect(oauthCompleted.connector.authMethod).toBe("oauth");
    expect(apiCompleted.connector.id).not.toBe(oauthCompleted.connector.id);
    await expect(completeSession(actor, api)).resolves.toMatchObject({
      connector: { id: apiCompleted.connector.id, authMethod: "api" },
    });
    await expect(completeSession(actor, oauth)).resolves.toMatchObject({
      connector: { id: oauthCompleted.connector.id, authMethod: "oauth" },
    });
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "test-oauth-device",
    );
    expect(
      accounts
        .map((account) => {
          return account.id;
        })
        .sort(),
    ).toStrictEqual(
      [apiCompleted.connector.id, oauthCompleted.connector.id].sort(),
    );
    await expectMissingSession(
      actor,
      "test-oauth-device",
      oauth.sessionId,
      api.sessionToken,
    );
    await expectMissingSession(
      actor,
      "test-oauth-device",
      api.sessionId,
      oauth.sessionToken,
    );
  });
});
