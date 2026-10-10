import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDeferredTestOAuthTokenEndpoint,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
const connectors = createConnectorBddApi(context);
const tokenUrl = "http://localhost:3000/api/test/oauth-provider/token";

type Session = { readonly sessionId: string; readonly sessionToken: string };

function pollSession(actor: ApiTestUser, session: Session) {
  return connectors.pollDeviceAuth(
    actor,
    "test-oauth-device",
    session.sessionId,
    session.sessionToken,
  );
}

async function completeSession(actor: ApiTestUser, session: Session) {
  const completed = await pollSession(actor, session);
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

async function createAccountPair(actor: ApiTestUser) {
  const first = await connectors.startDeviceAuth(
    actor,
    "test-oauth-device",
    "oauth",
  );
  const defaultAccount = await completeSession(actor, first);
  const second = await connectors.startDeviceAuth(
    actor,
    "test-oauth-device",
    "oauth",
  );
  const siblingAccount = await completeSession(actor, second);
  expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
  return { defaultAccount, siblingAccount };
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
  expect(accountIdentities(accounts)).toStrictEqual(
    accountIdentities(expected),
  );
  await expect(
    connectors.readConnectorBySlug(actor, "test-oauth-device"),
  ).resolves.toMatchObject({ id: defaultId });
}

function holdTerminalResponse(
  error: "access_denied" | "expired_token" | "invalid_request",
) {
  const started = createDeferredPromise<void>(context.signal);
  const gate = createDeferredPromise<void>(context.signal);
  server.use(
    http.post(tokenUrl, async () => {
      started.resolve(undefined);
      await gate.promise;
      return HttpResponse.json(
        { error, error_description: "Held terminal provider response" },
        { status: 400 },
      );
    }),
  );
  return {
    started: started.promise,
    release: () => {
      if (!gate.settled()) {
        gate.resolve(undefined);
      }
    },
  };
}

const superseded = {
  status: "error",
  errorCode: "session_superseded",
  errorMessage: "OAuth device authorization session was superseded",
} as const;

describe("Builtin device-auth terminal claim outcomes", () => {
  it.each(["access_denied", "expired_token", "invalid_request"] as const)(
    "preserves supersession and the exact replacement account after a held %s response",
    async (providerError) => {
      let release: (() => void) | undefined;
      const owned = createPublicConnectorActor(context, {
        beforeDrain: () => {
          release?.();
        },
      });
      await owned.run(async () => {
        const actor = owned.actor;
        owned.ownsFeatureSwitches();
        mockTestOAuthDeviceConnectorProvider();
        await connectors.updateFeatureSwitches(actor, {
          [FeatureSwitchKey.TestOauthConnector]: true,
        });
        const { defaultAccount, siblingAccount } =
          await createAccountPair(actor);
        const expected = [
          { id: defaultAccount.connector.id, isDefault: true },
          { id: siblingAccount.connector.id, isDefault: false },
        ];
        const old = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
          undefined,
          { intent: "reconnect", connectionId: siblingAccount.connector.id },
        );
        const held = holdTerminalResponse(providerError);
        release = held.release;
        const inFlight = owned.run(() => {
          return pollSession(actor, old);
        });
        await Promise.race([
          held.started,
          inFlight.then(() => {
            throw new Error(
              "Poll finished before its provider response was held",
            );
          }),
        ]);
        mockTestOAuthDeviceConnectorProvider({
          tokenScope: "read replacement",
        });
        const replacement = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
          undefined,
          { intent: "reconnect", connectionId: siblingAccount.connector.id },
        );
        expect(replacement.sessionId).not.toBe(old.sessionId);
        const completed = await completeSession(actor, replacement);
        expect(completed.connector.id).toBe(siblingAccount.connector.id);
        expect(completed.connector.oauthScopes).toStrictEqual([
          "read",
          "replacement",
        ]);
        held.release();
        await expect(inFlight).resolves.toStrictEqual(superseded);
        await expect(pollSession(actor, old)).resolves.toStrictEqual(
          superseded,
        );
        await expect(
          completeSession(actor, replacement),
        ).resolves.toStrictEqual(completed);
        await expectAccounts(actor, expected, defaultAccount.connector.id);
      });
    },
  );

  it("keeps a reclaimed poll current after its obsolete denial and completes the exact non-default account", async () => {
    let releaseOld: (() => void) | undefined;
    let releaseWinner: (() => void) | undefined;
    const owned = createPublicConnectorActor(context, {
      beforeDrain: () => {
        releaseOld?.();
        releaseWinner?.();
      },
      beforeWorkspaceCleanup: () => {
        clearMockNow();
        return Promise.resolve();
      },
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const { defaultAccount, siblingAccount } = await createAccountPair(actor);
      const expected = [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ];
      const startedAt = now();
      mockNow(startedAt);
      mockTestOAuthDeviceConnectorProvider({ interval: 3 });
      const session = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      mockNow(startedAt + 3000);
      const oldProvider = holdTerminalResponse("access_denied");
      releaseOld = oldProvider.release;
      const oldPoll = owned.run(() => {
        return pollSession(actor, session);
      });
      await Promise.race([
        oldProvider.started,
        oldPoll.then(() => {
          throw new Error(
            "Old poll finished before its provider response was held",
          );
        }),
      ]);
      mockNow(startedAt + 33_001);
      const winnerProvider = mockDeferredTestOAuthTokenEndpoint(context.signal);
      releaseWinner = winnerProvider.release;
      const winningPoll = owned.run(() => {
        return pollSession(actor, session);
      });
      await Promise.race([
        winnerProvider.started,
        winningPoll.then(() => {
          throw new Error(
            "Winning poll finished before its provider response was held",
          );
        }),
      ]);
      oldProvider.release();
      await expect(oldPoll).resolves.toStrictEqual({
        status: "pending",
        interval: 3,
      });
      await expect(pollSession(actor, session)).resolves.toStrictEqual({
        status: "pending",
        interval: 3,
      });
      await expectAccounts(actor, expected, defaultAccount.connector.id);
      winnerProvider.release();
      const completed = await winningPoll;
      expect(completed).toMatchObject({
        status: "complete",
        connector: {
          id: siblingAccount.connector.id,
          connectionStatus: "connected",
        },
      });
      await expect(completeSession(actor, session)).resolves.toStrictEqual(
        completed,
      );
      await expectAccounts(actor, expected, defaultAccount.connector.id);
    });
  });

  it("replays rejected reconnect completion after public account deletion and preserves its surviving default", async () => {
    const owned = createPublicConnectorActor(context);
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const { defaultAccount, siblingAccount } = await createAccountPair(actor);
      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "test-oauth-device",
        siblingAccount.connector.id,
      );
      const rejected = {
        status: "error",
        errorCode: "connector_account_rejected",
        errorMessage: "Connector account not found",
      };
      await expect(pollSession(actor, reconnect)).resolves.toStrictEqual(
        rejected,
      );
      await expect(pollSession(actor, reconnect)).resolves.toStrictEqual(
        rejected,
      );
      await expectAccounts(
        actor,
        [{ id: defaultAccount.connector.id, isDefault: true }],
        defaultAccount.connector.id,
      );
      const recovery = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const recovered = await completeSession(actor, recovery);
      expect(recovered.connector.id).not.toBe(siblingAccount.connector.id);
      expect(recovered.connector.id).not.toBe(defaultAccount.connector.id);
      await expect(pollSession(actor, reconnect)).resolves.toStrictEqual(
        rejected,
      );
      await expectAccounts(
        actor,
        [
          { id: defaultAccount.connector.id, isDefault: true },
          { id: recovered.connector.id, isDefault: false },
        ],
        defaultAccount.connector.id,
      );
    });
  });
});
