import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const connectors = createConnectorBddApi(context);
const tokenUrl = "http://localhost:3000/api/test/oauth-provider/token";

function replayOwner() {
  return createPublicConnectorActor(context, {
    beforeWorkspaceCleanup: () => {
      clearMockNow();
      return Promise.resolve();
    },
  });
}

async function enableDeviceAuth(actor: ApiTestUser) {
  mockTestOAuthDeviceConnectorProvider({ tokenScope: "read write" });
  await connectors.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.TestOauthConnector]: true,
  });
}

function expectNoSecrets(body: unknown, sessionToken: string): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(sessionToken);
  expect(serialized).not.toContain("test-device-access:");
  expect(serialized).not.toContain("test-device:");
}

async function completeSession(
  actor: ApiTestUser,
  session: { readonly sessionId: string; readonly sessionToken: string },
) {
  const completed = await connectors.pollDeviceAuth(
    actor,
    "test-oauth-device",
    session.sessionId,
    session.sessionToken,
  );
  if (completed.status !== "complete") {
    throw new Error(`Expected completed device session: ${completed.status}`);
  }
  expect(completed.account).toMatchObject({
    authMethod: "oauth",
    connectionStatus: "connected",
  });
  expectNoSecrets(completed, session.sessionToken);
  return completed;
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
  defaultId: string,
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "test-oauth-device",
  );
  const identities = accounts
    .map(({ id, isDefault }) => {
      return { id, isDefault };
    })
    .sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
  expect(identities).toStrictEqual(
    [...expected].sort((left, right) => {
      return left.id.localeCompare(right.id);
    }),
  );
  await expect(
    connectors.readDefaultBuiltinAccount(actor, "test-oauth-device"),
  ).resolves.toMatchObject({ id: defaultId });
}

// Completed sessions reload the exact account's current state.
describe("Builtin device-auth completed replay", () => {
  it("reloads the exact non-default account after reconnect and the completed session lifetime", async () => {
    mockSecretKmsHttp();
    const owned = replayOwner();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await enableDeviceAuth(actor);
      const startedAt = now();
      mockNow(startedAt);
      const defaultSession = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const sibling = await completeSession(actor, siblingSession);
      expect(sibling.connectionId).not.toBe(defaultAccount.connectionId);
      expect(sibling.account.oauthScopes).toStrictEqual(["read", "write"]);
      mockTestOAuthDeviceConnectorProvider({ tokenScope: "read" });
      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: sibling.connectionId },
      );
      const reconnected = await completeSession(actor, reconnect);
      expect(reconnected.account).toMatchObject({
        id: sibling.connectionId,
        oauthScopes: ["read"],
      });
      mockNow(startedAt + siblingSession.expiresIn * 1000 + 1);
      server.use(
        http.post(tokenUrl, () => {
          return HttpResponse.json({ error: "server_error" }, { status: 503 });
        }),
      );
      const replayed = await completeSession(actor, siblingSession);
      expect(replayed.account).toMatchObject({
        id: sibling.connectionId,
        oauthScopes: ["read"],
      });
      await expectAccounts(
        actor,
        [
          { id: defaultAccount.connectionId, isDefault: true },
          { id: sibling.connectionId, isDefault: false },
        ],
        defaultAccount.connectionId,
      );
    });
  });

  it("fails completed replay after the exact account is deleted rather than substituting the surviving default", async () => {
    mockSecretKmsHttp();
    const owned = replayOwner();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await enableDeviceAuth(actor);
      mockNow(now());
      const defaultSession = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const sibling = await completeSession(actor, siblingSession);
      expect(sibling.connectionId).not.toBe(defaultAccount.connectionId);
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "test-oauth-device",
        sibling.connectionId,
      );
      const replayed = await connectors.requestDeviceAuthPoll(
        actor,
        "test-oauth-device",
        siblingSession.sessionId,
        siblingSession.sessionToken,
        [500],
      );
      expect(replayed.body).toStrictEqual({ error: "Internal server error" });
      expectNoSecrets(replayed.body, siblingSession.sessionToken);
      await expectAccounts(
        actor,
        [{ id: defaultAccount.connectionId, isDefault: true }],
        defaultAccount.connectionId,
      );
    });
  });
});
