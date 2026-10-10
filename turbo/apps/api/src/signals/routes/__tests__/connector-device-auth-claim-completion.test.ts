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
    throw new Error("Expected completed device session: " + completed.status);
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
  defaultId: string,
  siblingId: string,
  siblingScopes: readonly string[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "test-oauth-device",
  );
  const actual = accounts.map(({ id, isDefault, oauthScopes }) => {
    return { id, isDefault, oauthScopes };
  });
  const expected = [
    { id: defaultId, isDefault: true, oauthScopes: ["read", "baseline"] },
    { id: siblingId, isDefault: false, oauthScopes: siblingScopes },
  ];
  const byId = (left: { id: string }, right: { id: string }) => {
    return left.id.localeCompare(right.id);
  };
  expect(actual.sort(byId)).toStrictEqual(expected.sort(byId));
  await expect(
    connectors.readConnectorBySlug(actor, "test-oauth-device"),
  ).resolves.toMatchObject({
    id: defaultId,
    oauthScopes: ["read", "baseline"],
  });
}

function holdSuccessfulResponse(scope: string) {
  const started = createDeferredPromise<void>(context.signal);
  const gate = createDeferredPromise<void>(context.signal);
  server.use(
    http.post(tokenUrl, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const deviceCode = body.get("device_code");
      if (!deviceCode) {
        throw new Error("Expected a provider device code");
      }
      started.resolve(undefined);
      await gate.promise;
      return HttpResponse.json({
        access_token: "test-device-access:" + deviceCode,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
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

describe("Builtin device-auth retained-claim completion", () => {
  it("preserves the replacement's exact non-default account and scopes after an obsolete successful reconnect", async () => {
    let release: (() => void) | undefined;
    const owned = createPublicConnectorActor(context, {
      beforeDrain: () => {
        release?.();
      },
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      mockTestOAuthDeviceConnectorProvider({ tokenScope: "read baseline" });
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const { defaultAccount, siblingAccount } = await createAccountPair(actor);
      const old = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      const held = holdSuccessfulResponse("read obsolete");
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

      mockTestOAuthDeviceConnectorProvider({ tokenScope: "read replacement" });
      const replacement = await connectors.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
        undefined,
        { intent: "reconnect", connectionId: siblingAccount.connector.id },
      );
      expect(replacement.sessionId).not.toBe(old.sessionId);
      const completed = await completeSession(actor, replacement);
      expect(completed.connector).toMatchObject({
        id: siblingAccount.connector.id,
        oauthScopes: ["read", "replacement"],
      });
      held.release();
      await expect(inFlight).resolves.toStrictEqual(superseded);
      await expect(pollSession(actor, old)).resolves.toStrictEqual(superseded);
      await expect(completeSession(actor, replacement)).resolves.toStrictEqual(
        completed,
      );
      await expectAccounts(
        actor,
        defaultAccount.connector.id,
        siblingAccount.connector.id,
        ["read", "replacement"],
      );
    });
  });

  it("keeps the winning reclaimed reconnect pending without publishing the obsolete successful scopes", async () => {
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
      mockTestOAuthDeviceConnectorProvider({ tokenScope: "read baseline" });
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      const { defaultAccount, siblingAccount } = await createAccountPair(actor);
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
      const oldProvider = holdSuccessfulResponse("read obsolete");
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
      const winnerProvider = holdSuccessfulResponse("read winner");
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
      const pending = { status: "pending", interval: 3 };
      await expect(oldPoll).resolves.toStrictEqual(pending);
      await expect(pollSession(actor, session)).resolves.toStrictEqual(pending);
      await expectAccounts(
        actor,
        defaultAccount.connector.id,
        siblingAccount.connector.id,
        ["read", "baseline"],
      );
      winnerProvider.release();
      const completed = await winningPoll;
      expect(completed).toMatchObject({
        status: "complete",
        connector: {
          id: siblingAccount.connector.id,
          authMethod: "oauth",
          connectionStatus: "connected",
          oauthScopes: ["read", "winner"],
        },
      });
      await expect(completeSession(actor, session)).resolves.toStrictEqual(
        completed,
      );
      await expectAccounts(
        actor,
        defaultAccount.connector.id,
        siblingAccount.connector.id,
        ["read", "winner"],
      );
    });
  });
});
