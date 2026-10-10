import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDeferredTestOAuthTokenEndpoint,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

function accountIdentities(
  accounts: readonly { readonly id: string; readonly isDefault: boolean }[],
) {
  return accounts
    .map(({ id, isDefault }) => {
      return { id, isDefault };
    })
    .sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
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
  const serialized = JSON.stringify(completed);
  expect(serialized).not.toContain(session.sessionToken);
  expect(serialized).not.toContain("test-device-access:");
  expect(serialized).not.toContain("test-device:");
  return completed;
}

async function expectMissingSession(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const rejected = await connectors.requestDeviceAuthPoll(
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

describe("Builtin device-auth initial poll claims", () => {
  it("recovers a failed reconnect into the exact non-default account without changing its sibling", async () => {
    const owned = createPublicConnectorActor(context);
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });

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
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
      const expected = accountIdentities([
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ]);

      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      mockTestOAuthDeviceConnectorProvider({ tokenBehavior: "emptyJson" });
      const failed = await connectors.requestDeviceAuthPoll(
        actor,
        "test-oauth-device",
        reconnect.sessionId,
        reconnect.sessionToken,
        [500],
      );
      expect(failed.status).toBe(500);
      expect(failed.body).toStrictEqual({ error: "Internal server error" });
      const afterFailure = await connectors.listBuiltinConnectorAccounts(
        actor,
        "test-oauth-device",
      );
      expect(accountIdentities(afterFailure)).toStrictEqual(expected);
      await expect(
        connectors.readConnectorBySlug(actor, "test-oauth-device"),
      ).resolves.toMatchObject({ id: defaultAccount.connector.id });

      mockTestOAuthDeviceConnectorProvider();
      await expect(completeSession(actor, reconnect)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expect(completeSession(actor, reconnect)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      const afterRecovery = await connectors.listBuiltinConnectorAccounts(
        actor,
        "test-oauth-device",
      );
      expect(accountIdentities(afterRecovery)).toStrictEqual(expected);
      await expect(
        connectors.readConnectorBySlug(actor, "test-oauth-device"),
      ).resolves.toMatchObject({ id: defaultAccount.connector.id });
    });
  });

  it("enforces identity and the strict stale boundary before preserving the winning reclaimed account", async () => {
    const owned = createPublicConnectorActor(context);
    onTestFinished(() => {
      clearMockNow();
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const startedAt = now();
      mockNow(startedAt);
      const session = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const held = mockDeferredTestOAuthTokenEndpoint(context.signal);
      const stalePoll = connectors.pollDeviceAuth(
        actor,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      onTestFinished(async () => {
        held.release();
        await stalePoll;
      });

      await (async () => {
        await Promise.race([
          held.started,
          stalePoll.then(() => {
            throw new Error("Poll finished before the token exchange started");
          }),
        ]);
        const peer = bdd.user({ orgId: actor.orgId });
        const foreignOrg = bdd.user({ userId: actor.userId });
        expect(peer.userId).not.toBe(actor.userId);
        expect(foreignOrg.userId).toBe(actor.userId);
        expect(foreignOrg.orgId).not.toBe(actor.orgId);
        const rejections = [
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
          { actor, connectorSlug: "github", token: session.sessionToken },
          {
            actor,
            connectorSlug: "test-oauth-device",
            token: "wrong-session-token",
          },
        ] as const;
        for (const rejected of rejections) {
          await expectMissingSession(
            rejected.actor,
            rejected.connectorSlug,
            session.sessionId,
            rejected.token,
          );
        }

        mockNow(startedAt + 30_000);
        await expect(
          connectors.pollDeviceAuth(
            actor,
            "test-oauth-device",
            session.sessionId,
            session.sessionToken,
          ),
        ).resolves.toStrictEqual({ status: "pending", interval: 0 });
        await expect(
          connectors.listBuiltinConnectorAccounts(actor, "test-oauth-device"),
        ).resolves.toStrictEqual([]);

        mockNow(startedAt + 30_001);
        mockTestOAuthDeviceConnectorProvider({ tokenScope: "read reclaimed" });
        const completed = await completeSession(actor, session);
        expect(completed.connector.oauthScopes).toStrictEqual([
          "read",
          "reclaimed",
        ]);
        held.release();
        await expect(stalePoll).resolves.toStrictEqual({
          status: "pending",
          interval: 0,
        });
        await expect(completeSession(actor, session)).resolves.toStrictEqual(
          completed,
        );
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "test-oauth-device",
        );
        expect(accounts).toStrictEqual([
          expect.objectContaining({
            id: completed.connector.id,
            authMethod: "oauth",
            isDefault: true,
            oauthScopes: ["read", "reclaimed"],
            connectionStatus: "connected",
          }),
        ]);
      })().finally(() => {
        held.release();
      });
    });
  });
});
