import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const connectors = createConnectorBddApi(context);

function createActor() {
  mockAwsExternalCodeProvider();
  return createPublicConnectorActor(context, {
    beforeWorkspaceCleanup: () => {
      clearMockNow();
      return Promise.resolve();
    },
  });
}

function completionInput(
  session: BuiltinConnectorExternalCodeSessionStartResponse,
) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    code: awsVerificationCode(session.authorizationUrl),
  };
}

function expectNoSecrets(body: unknown, sessionToken: string): void {
  const serialized = JSON.stringify(body);
  for (const secret of [
    sessionToken,
    "aws-secret-access-key",
    "aws-login-refresh-token",
    "aws-session-token",
    "aws-id-token",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function completeSession(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
) {
  const completed = await connectors.completeExternalCode(
    actor,
    "aws",
    completionInput(session),
  );
  expect(completed).toMatchObject({
    status: "complete",
    account: {
      target: { kind: "builtin", connectorSlug: "aws" },
      authMethod: "cli",
      connectionStatus: "connected",
    },
  });
  expectNoSecrets(completed, session.sessionToken);
  return completed;
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(actor, "aws");
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

describe("Builtin external-code completed replay", () => {
  beforeEach(mockSecretKmsHttp);

  it("replays current non-default account state after reconnect and the original session lifetime", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const startedAt = now();
      mockNow(startedAt);
      const defaultSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connectionId).not.toBe(defaultAccount.connectionId);

      mockNow(startedAt + siblingSession.expiresIn * 1000 + 1);
      const reconnect = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        {
          intent: "reconnect",
          connectionId: siblingAccount.connectionId,
        },
      );
      const reconnected = await completeSession(actor, reconnect);
      expect(reconnected.connectionId).toBe(siblingAccount.connectionId);
      expect(reconnected.account.updatedAt).not.toBe(
        siblingAccount.account.updatedAt,
      );
      expect(reconnected.account.tokenExpiresAt).not.toBe(
        siblingAccount.account.tokenExpiresAt,
      );
      server.use(
        http.post("https://us-east-1.signin.aws.amazon.com/v1/token", () => {
          return HttpResponse.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
        }),
      );
      await expect(
        completeSession(actor, siblingSession),
      ).resolves.toStrictEqual(reconnected);
      await expectAccounts(actor, [
        { id: defaultAccount.connectionId, isDefault: true },
        { id: siblingAccount.connectionId, isDefault: false },
      ]);
      await expect(
        connectors.readDefaultBuiltinAccount(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connectionId,
      });
    });
  });

  it("fails replay after the completed non-default account is deleted while its default survives", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const defaultSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connectionId).not.toBe(defaultAccount.connectionId);
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "aws",
        siblingAccount.connectionId,
      );

      const replay = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(siblingSession),
        [500],
      );
      expect(replay.body).toStrictEqual({ error: "Internal server error" });
      expectNoSecrets(replay.body, siblingSession.sessionToken);
      await expectAccounts(actor, [
        { id: defaultAccount.connectionId, isDefault: true },
      ]);
      await expect(
        connectors.readDefaultBuiltinAccount(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connectionId,
      });
    });
  });
});
