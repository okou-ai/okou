import { builtinConnectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../connectors-oauth-device-auth";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  createConnectorBddApi,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const agents = createAuthOrgAgentsBddApi(context);
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
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
  expect(completed.connector).toMatchObject({
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
    connectors.readConnectorBySlug(actor, "test-oauth-device"),
  ).resolves.toMatchObject({ id: defaultId });
}

// Completed sessions remain exact-account replay handles, not remembered
// connector snapshots or authority to substitute another account or Agent.
describe("Builtin device-auth completed replay", () => {
  it("reloads the exact non-default account after reconnect and the completed session lifetime", async () => {
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
      expect(sibling.connector.id).not.toBe(defaultAccount.connector.id);
      expect(sibling.connector.oauthScopes).toStrictEqual(["read", "write"]);
      mockTestOAuthDeviceConnectorProvider({ tokenScope: "read" });
      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: sibling.connector.id },
      );
      const reconnected = await completeSession(actor, reconnect);
      expect(reconnected.connector).toMatchObject({
        id: sibling.connector.id,
        oauthScopes: ["read"],
      });
      mockNow(startedAt + siblingSession.expiresIn * 1000 + 1);
      server.use(
        http.post(tokenUrl, () => {
          return HttpResponse.json({ error: "server_error" }, { status: 503 });
        }),
      );
      const replayed = await completeSession(actor, siblingSession);
      expect(replayed.connector).toMatchObject({
        id: sibling.connector.id,
        oauthScopes: ["read"],
      });
      expect(replayed.connector.oauthScopes).not.toStrictEqual(
        sibling.connector.oauthScopes,
      );
      await expectAccounts(
        actor,
        [
          { id: defaultAccount.connector.id, isDefault: true },
          { id: sibling.connector.id, isDefault: false },
        ],
        defaultAccount.connector.id,
      );
    });
  });

  it("fails completed replay after the exact account is deleted rather than substituting the surviving default", async () => {
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
      expect(sibling.connector.id).not.toBe(defaultAccount.connector.id);
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "test-oauth-device",
        sibling.connector.id,
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
        [{ id: defaultAccount.connector.id, isDefault: true }],
        defaultAccount.connector.id,
      );
    });
  });

  it("rechecks the completed session's explicit Agent and does not substitute a surviving default Agent", async () => {
    const owned = replayOwner();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await enableDeviceAuth(actor);
      mockNow(now());
      bdd.acceptAgentStorageWrites();
      const { body: defaultAgent } =
        await agents.bootstrapLimitedFreeOnboarding(actor, {
          displayName: "Surviving Completed Replay Default",
        });
      const target = await agents.createAgent(actor, {
        displayName: "Deleted Completed Replay Target",
      });
      expect(target.agentId).not.toBe(defaultAgent.agentId);
      const defaultGrants = await agents.readEnabledConnectorSlugs(
        actor,
        defaultAgent.agentId,
      );
      const targetGrants = await agents.readEnabledConnectorSlugs(
        actor,
        target.agentId,
      );
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const client = setupApp({
        context,
        routes: builtinConnectorsOauthDeviceAuthRoutes,
      })(builtinConnectorOauthDeviceAuthSessionContract);
      const started = await accept(
        client.create({
          params: { connectorSlug: "test-oauth-device" },
          headers: { authorization: "Bearer clerk-session" },
          body: {
            authMethod: "oauth",
            agentId: target.agentId,
            authorizeAgent: true,
            account: { intent: "add" },
          },
        }),
        [200],
      );
      const completed = await completeSession(actor, started.body);
      const authorized = await agents.readEnabledConnectorSlugs(
        actor,
        target.agentId,
      );
      expect([...authorized].sort()).toStrictEqual(
        [...new Set([...targetGrants, "test-oauth-device"])].sort(),
      );
      await expect(
        agents.readEnabledConnectorSlugs(actor, defaultAgent.agentId),
      ).resolves.toStrictEqual(defaultGrants);
      await bdd.deleteAgent(actor, target.agentId);
      const replayed = await connectors.requestDeviceAuthPoll(
        actor,
        "test-oauth-device",
        started.body.sessionId,
        started.body.sessionToken,
        [400],
      );
      expect(replayed.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: `Agent not found: ${target.agentId}`,
        },
      });
      expectNoSecrets(replayed.body, started.body.sessionToken);
      await expectAccounts(
        actor,
        [{ id: completed.connector.id, isDefault: true }],
        completed.connector.id,
      );
      await expect(
        agents.readEnabledConnectorSlugs(actor, defaultAgent.agentId),
      ).resolves.toStrictEqual(defaultGrants);
    });
  });
});
