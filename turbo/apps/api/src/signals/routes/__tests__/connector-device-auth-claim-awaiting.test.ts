import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
const connectors = createConnectorBddApi(context);
const tokenUrl = "http://localhost:3000/api/test/oauth-provider/token";

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

function holdTokenResponse(
  response: "pending" | "malformed",
  signal: AbortSignal,
) {
  const started = createDeferredPromise<void>(signal);
  const gate = createDeferredPromise<void>(signal);
  const release = (): void => {
    if (!gate.settled()) {
      gate.resolve(undefined);
    }
  };
  onTestFinished(() => {
    release();
  });
  server.use(
    http.post(tokenUrl, async () => {
      if (!started.settled()) {
        started.resolve(undefined);
      }
      await gate.promise;
      return response === "pending"
        ? HttpResponse.json({ error: "authorization_pending" }, { status: 400 })
        : HttpResponse.json({});
    }),
  );
  return { started: started.promise, release };
}

async function expectAccountIdentities(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
  defaultId: string,
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "test-oauth-device",
  );
  expect(accountIdentities(accounts)).toStrictEqual(expected);
  await expect(
    connectors.readConnectorBySlug(actor, "test-oauth-device"),
  ).resolves.toMatchObject({ id: defaultId });
}

// A normal caller's interval responses and replacement sessions are the
// observation boundary; only the external token response is controlled.
describe("Builtin device-auth awaiting restoration", () => {
  it("preserves strict pending, slow-down and failed-poll intervals while recovering the exact non-default account", async () => {
    const owned = createPublicConnectorActor(context, {
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
      mockTestOAuthDeviceConnectorProvider({ interval: 2 });
      const reconnect = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      const poll = () => {
        return connectors.pollDeviceAuth(
          actor,
          "test-oauth-device",
          reconnect.sessionId,
          reconnect.sessionToken,
        );
      };
      server.use(
        http.post(tokenUrl, () => {
          return HttpResponse.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        }),
      );
      mockNow(startedAt + 2000);
      await expect(poll()).resolves.toStrictEqual({
        status: "pending",
        interval: 2,
      });
      server.use(
        http.post(tokenUrl, () => {
          return HttpResponse.json({ error: "slow_down" }, { status: 400 });
        }),
      );
      mockNow(startedAt + 3999);
      await expect(poll()).resolves.toStrictEqual({
        status: "pending",
        interval: 2,
      });
      mockNow(startedAt + 4000);
      await expect(poll()).resolves.toStrictEqual({
        status: "pending",
        interval: 7,
      });
      mockTestOAuthDeviceConnectorProvider({ tokenBehavior: "emptyJson" });
      mockNow(startedAt + 10_999);
      await expect(poll()).resolves.toStrictEqual({
        status: "pending",
        interval: 7,
      });
      mockNow(startedAt + 11_000);
      const failed = await connectors.requestDeviceAuthPoll(
        actor,
        "test-oauth-device",
        reconnect.sessionId,
        reconnect.sessionToken,
        [500],
      );
      expect(failed.status).toBe(500);
      expect(failed.body).toStrictEqual({ error: "Internal server error" });
      await expectAccountIdentities(
        actor,
        expected,
        defaultAccount.connector.id,
      );
      mockTestOAuthDeviceConnectorProvider();
      mockNow(startedAt + 17_999);
      await expect(poll()).resolves.toStrictEqual({
        status: "pending",
        interval: 7,
      });
      mockNow(startedAt + 18_000);
      const recovered = await completeSession(actor, reconnect);
      expect(recovered.connector.id).toBe(siblingAccount.connector.id);
      await expect(completeSession(actor, reconnect)).resolves.toStrictEqual(
        recovered,
      );
      await expectAccountIdentities(
        actor,
        expected,
        defaultAccount.connector.id,
      );
    });
  });

  it.each(["pending", "malformed"] as const)(
    "does not restore a superseded claim after its old %s provider response or disturb the replacement account",
    async (response) => {
      let releasePendingResponse: (() => void) | undefined;
      const owned = createPublicConnectorActor(context, {
        beforeDrain: () => {
          releasePendingResponse?.();
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
        mockNow(now());
        const old = await connectors.startDeviceAuth(
          actor,
          "test-oauth-device",
          "oauth",
        );
        const held = holdTokenResponse(response, context.signal);
        releasePendingResponse = held.release;
        const inFlight = owned.run(() => {
          return connectors.pollDeviceAuth(
            actor,
            "test-oauth-device",
            old.sessionId,
            old.sessionToken,
          );
        });
        onTestFinished(async () => {
          held.release();
          await inFlight;
        });
        await (async () => {
          await Promise.race([
            held.started,
            inFlight.then(() => {
              throw new Error(
                "Poll finished before the token exchange started",
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
          );
          expect(replacement.sessionId).not.toBe(old.sessionId);
          const completed = await completeSession(actor, replacement);
          expect(completed.connector.oauthScopes).toStrictEqual([
            "read",
            "replacement",
          ]);
          held.release();
          const superseded = {
            status: "error",
            errorCode: "session_superseded",
            errorMessage: "OAuth device authorization session was superseded",
          };
          await expect(inFlight).resolves.toStrictEqual(superseded);
          await expect(
            connectors.pollDeviceAuth(
              actor,
              "test-oauth-device",
              old.sessionId,
              old.sessionToken,
            ),
          ).resolves.toStrictEqual(superseded);
          await expect(
            completeSession(actor, replacement),
          ).resolves.toStrictEqual(completed);
          await expectAccountIdentities(
            actor,
            [{ id: completed.connector.id, isDefault: true }],
            completed.connector.id,
          );
        })().finally(() => {
          held.release();
        });
      });
    },
  );
});
