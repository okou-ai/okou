import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDeferredTestOAuthTokenEndpoint,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
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

const expiredResponse = {
  status: "expired",
  errorCode: "expired_token",
  errorMessage: "OAuth device authorization session expired",
} as const;

async function expectExpiredSession(
  actor: ApiTestUser,
  session: { readonly sessionId: string; readonly sessionToken: string },
): Promise<void> {
  await expect(
    connectors.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    ),
  ).resolves.toStrictEqual(expiredResponse);
}

describe("Builtin device-auth session expiration", () => {
  it("expires an exact non-default reconnect only after its deadline and preserves both accounts through recovery", async () => {
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

      mockTestOAuthDeviceConnectorProvider({
        deviceCode: "pending",
        interval: 0,
        expiresIn: 60,
      });
      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      expect(reconnect.expiresIn).toBe(60);
      const deadline = startedAt + reconnect.expiresIn * 1000;
      mockNow(deadline);
      await expect(
        connectors.pollDeviceAuth(
          actor,
          "test-oauth-device",
          reconnect.sessionId,
          reconnect.sessionToken,
        ),
      ).resolves.toStrictEqual({ status: "pending", interval: 0 });
      mockNow(deadline + 1);
      await expectExpiredSession(actor, reconnect);
      mockTestOAuthDeviceConnectorProvider();
      await expectExpiredSession(actor, reconnect);
      const afterExpiration = await connectors.listBuiltinConnectorAccounts(
        actor,
        "test-oauth-device",
      );
      expect(accountIdentities(afterExpiration)).toStrictEqual(expected);
      await expect(
        connectors.readConnectorBySlug(actor, "test-oauth-device"),
      ).resolves.toMatchObject({ id: defaultAccount.connector.id });

      const recovery = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      await expect(completeSession(actor, recovery)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expectExpiredSession(actor, reconnect);
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

  it("preserves a fresh poll past expiry then expires at the freshness boundary without publishing its late successful account", async () => {
    const owned = createPublicConnectorActor(context);
    onTestFinished(() => {
      clearMockNow();
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider({ interval: 0, expiresIn: 1 });
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
      expect(session.expiresIn).toBe(1);
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
        mockNow(startedAt + 29_999);
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

        mockNow(startedAt + 30_000);
        await expectExpiredSession(actor, session);
        await expectExpiredSession(actor, session);
        held.release();
        await expect(stalePoll).resolves.toStrictEqual(expiredResponse);
        await expectExpiredSession(actor, session);
        await expect(
          connectors.listBuiltinConnectorAccounts(actor, "test-oauth-device"),
        ).resolves.toStrictEqual([]);
      })().finally(() => {
        held.release();
      });
    });
  });
});
