import type { BuiltinConnectorOauthDeviceAuthSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDeferredTestOAuthTokenEndpoint,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const connectors = createConnectorBddApi(context);

const supersededResponse = {
  status: "error",
  errorCode: "session_superseded",
  errorMessage: "OAuth device authorization session was superseded",
} as const;

async function completeSession(
  actor: ApiTestUser,
  session: BuiltinConnectorOauthDeviceAuthSessionStartResponse,
) {
  expect(session).toMatchObject({
    connectorSlug: "test-oauth-device",
    status: "pending",
    userCode: "TEST-DEVICE",
    verificationUri: "https://oauth-device.test/device",
    verificationUriComplete:
      "https://oauth-device.test/device?user_code=TEST-DEVICE",
    expiresIn: 600,
    interval: 0,
  });
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
    target: { kind: "builtin", connectorSlug: "test-oauth-device" },
    authMethod: "oauth",
    connectionStatus: "connected",
  });
  for (const secret of [
    session.sessionToken,
    "test-device-access:",
    "test-device:",
  ]) {
    expect(JSON.stringify(completed)).not.toContain(secret);
  }
  return completed;
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "test-oauth-device",
  );
  const byId = (
    left: { readonly id: string },
    right: { readonly id: string },
  ) => {
    return left.id.localeCompare(right.id);
  };
  expect(
    accounts
      .map(({ id, isDefault }) => {
        return { id, isDefault };
      })
      .sort(byId),
  ).toStrictEqual([...expected].sort(byId));
}

async function expectSuperseded(
  actor: ApiTestUser,
  session: BuiltinConnectorOauthDeviceAuthSessionStartResponse,
): Promise<void> {
  const result = await connectors.pollDeviceAuth(
    actor,
    "test-oauth-device",
    session.sessionId,
    session.sessionToken,
  );
  expect(result).toStrictEqual(supersededResponse);
}

describe("Builtin device-auth session creation", () => {
  it("replaces matching waiting sessions while preserving completed replay, another workspace and the chosen non-default account", async () => {
    mockSecretKmsHttp();
    const owned = createPublicConnectorActor(context);
    const foreign = createPublicConnectorActor(context);
    expect(owned.actor.orgId).not.toBe(foreign.actor.orgId);
    await owned.run(async () => {
      await foreign.run(async () => {
        const actor = owned.actor;
        owned.ownsFeatureSwitches();
        foreign.ownsFeatureSwitches();
        mockTestOAuthDeviceConnectorProvider();
        await connectors.updateFeatureSwitches(actor, {
          [FeatureSwitchKey.TestOauthConnector]: true,
        });
        await connectors.updateFeatureSwitches(foreign.actor, {
          [FeatureSwitchKey.TestOauthConnector]: true,
        });
        const defaultSession = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
        );
        const defaultAccount = await completeSession(actor, defaultSession);
        const siblingAccount = await completeSession(
          actor,
          await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
        );
        expect(siblingAccount.connectionId).not.toBe(
          defaultAccount.connectionId,
        );
        const choice = {
          intent: "reconnect",
          connectionId: siblingAccount.connectionId,
        } as const;
        const pending = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
          undefined,
          choice,
        );
        const foreignPending = await connectors.startDeviceAuth(
          foreign.actor,
          "test-oauth-device",
          "oauth",
        );
        const replacement = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
          undefined,
          choice,
        );
        expect(replacement.sessionId).not.toBe(pending.sessionId);
        expect(replacement.sessionToken).not.toBe(pending.sessionToken);
        await expectSuperseded(actor, pending);
        await expect(
          completeSession(actor, defaultSession),
        ).resolves.toMatchObject({
          connector: { id: defaultAccount.connectionId },
        });
        const foreignAccount = await completeSession(
          foreign.actor,
          foreignPending,
        );
        const foreignReconnect = await connectors.requestDeviceAuthStart(
          actor,
          "test-oauth-device",
          "oauth",
          undefined,
          [404],
          { intent: "reconnect", connectionId: foreignAccount.connectionId },
        );
        expect(foreignReconnect.body).toStrictEqual({
          error: { code: "NOT_FOUND", message: "Connector account not found" },
        });
        await expect(
          completeSession(actor, replacement),
        ).resolves.toMatchObject({
          connector: { id: siblingAccount.connectionId },
        });
        await expectAccounts(actor, [
          { id: defaultAccount.connectionId, isDefault: true },
          { id: siblingAccount.connectionId, isDefault: false },
        ]);
        await expectAccounts(foreign.actor, [
          { id: foreignAccount.connectionId, isDefault: true },
        ]);
      });
    });
  });

  it("rejects reconnect to a deleted account without retiring a previously usable waiting session", async () => {
    mockSecretKmsHttp();
    const owned = createPublicConnectorActor(context);
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const defaultAccount = await completeSession(
        actor,
        await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
      );
      const siblingAccount = await completeSession(
        actor,
        await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
      );
      const deletedAccount = await completeSession(
        actor,
        await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
      );
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "test-oauth-device",
        deletedAccount.connectionId,
      );
      const pending = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connectionId },
      );
      const rejected = await connectors.requestDeviceAuthStart(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        [404],
        { intent: "reconnect", connectionId: deletedAccount.connectionId },
      );
      expect(rejected.body).toStrictEqual({
        error: { code: "NOT_FOUND", message: "Connector account not found" },
      });
      await expect(completeSession(actor, pending)).resolves.toMatchObject({
        connector: { id: siblingAccount.connectionId },
      });
      await expectAccounts(actor, [
        { id: defaultAccount.connectionId, isDefault: true },
        { id: siblingAccount.connectionId, isDefault: false },
      ]);
    });
  });

  it("retires an in-flight polling claim without publishing its account when a replacement session is started", async () => {
    mockSecretKmsHttp();
    let provider:
      ReturnType<typeof mockDeferredTestOAuthTokenEndpoint> | undefined;
    const owned = createPublicConnectorActor(context, {
      beforeDrain: () => {
        provider?.release();
      },
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const defaultAccount = await completeSession(
        actor,
        await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
      );
      const siblingAccount = await completeSession(
        actor,
        await connectors.startDeviceAuth(actor, "test-oauth-device", "oauth"),
      );
      const choice = {
        intent: "reconnect",
        connectionId: siblingAccount.connectionId,
      } as const;
      const pending = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      provider = mockDeferredTestOAuthTokenEndpoint(context.signal);
      const inFlight = owned.run(() => {
        return connectors.pollDeviceAuth(
          actor,
          "test-oauth-device",
          pending.sessionId,
          pending.sessionToken,
        );
      });
      await Promise.race([
        provider.started,
        inFlight.then(() => {
          throw new Error("Poll finished before the provider exchange started");
        }),
      ]);
      const replacement = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        choice,
      );
      await expectSuperseded(actor, pending);
      provider.release();
      await expect(inFlight).resolves.toStrictEqual(supersededResponse);
      await expectAccounts(actor, [
        { id: defaultAccount.connectionId, isDefault: true },
        { id: siblingAccount.connectionId, isDefault: false },
      ]);
      mockTestOAuthDeviceConnectorProvider();
      await expect(completeSession(actor, replacement)).resolves.toMatchObject({
        connector: { id: siblingAccount.connectionId },
      });
      await expectSuperseded(actor, pending);
      await expectAccounts(actor, [
        { id: defaultAccount.connectionId, isDefault: true },
        { id: siblingAccount.connectionId, isDefault: false },
      ]);
    });
  });
});
