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
  expect(completed.account.connectionStatus).toBe("connected");
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
    expect(completed.account.authMethod).toBe("oauth");
    await expect(
      connectorsApi.readDefaultBuiltinAccount(actor, "test-oauth-device"),
    ).resolves.toMatchObject({ id: completed.connectionId });

    for (const candidate of rejectionCases) {
      await expectMissingSession(
        candidate.actor,
        candidate.connectorSlug,
        session.sessionId,
        candidate.token,
      );
    }
    await expect(completeSession(actor, session)).resolves.toMatchObject({
      connectionId: completed.connectionId,
      account: { id: completed.connectionId, authMethod: "oauth" },
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
    expect(apiCompleted.account.authMethod).toBe("api");
    expect(oauthCompleted.account.authMethod).toBe("oauth");
    expect(apiCompleted.connectionId).not.toBe(oauthCompleted.connectionId);
    await expect(completeSession(actor, api)).resolves.toMatchObject({
      connectionId: apiCompleted.connectionId,
      account: { id: apiCompleted.connectionId, authMethod: "api" },
    });
    await expect(completeSession(actor, oauth)).resolves.toMatchObject({
      connectionId: oauthCompleted.connectionId,
      account: { id: oauthCompleted.connectionId, authMethod: "oauth" },
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
      [apiCompleted.connectionId, oauthCompleted.connectionId].sort(),
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
