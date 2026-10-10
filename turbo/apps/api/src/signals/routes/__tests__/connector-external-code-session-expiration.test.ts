import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsDeferredTokenExchange,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
const connectors = createConnectorBddApi(context);

function createActor() {
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
    connector: {
      slug: "aws",
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
  const identities = accounts.map(({ id, isDefault }) => {
    return { id, isDefault };
  });
  const byId = (
    left: { readonly id: string },
    right: { readonly id: string },
  ) => {
    return left.id.localeCompare(right.id);
  };
  expect(identities.sort(byId)).toStrictEqual([...expected].sort(byId));
}

async function expectExpiredSession(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
): Promise<void> {
  const response = await connectors.requestExternalCodeComplete(
    actor,
    "aws",
    completionInput(session),
    [400],
  );
  expect(response.body).toStrictEqual({
    error: {
      code: "BAD_REQUEST",
      message: "External-code authorization session expired",
    },
  });
  expectNoSecrets(response.body, session.sessionToken);
}

async function expectCompletingSession(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
): Promise<void> {
  const response = await connectors.requestExternalCodeComplete(
    actor,
    "aws",
    completionInput(session),
    [400],
  );
  expect(response.body).toStrictEqual({
    error: {
      code: "BAD_REQUEST",
      message: "External-code authorization session is already completing",
    },
  });
  expectNoSecrets(response.body, session.sessionToken);
}

describe("Builtin external-code session expiration", () => {
  it("expires an exact non-default reconnect only after its deadline and preserves both accounts through recovery and completed replay", async () => {
    mockAwsExternalCodeProvider();
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
        {
          intent: "add",
        },
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        {
          intent: "add",
        },
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
      const expected = [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ];
      await expectAccounts(actor, expected);
      const reconnect = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        {
          intent: "reconnect",
          connectionId: siblingAccount.connector.id,
        },
      );
      const deadline = startedAt + reconnect.expiresIn * 1000;
      mockNow(deadline);
      const rejected = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        {
          ...completionInput(reconnect),
          code: awsVerificationCode(reconnect.authorizationUrl, "AWS-BAD"),
        },
        [400],
      );
      expect(rejected.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message:
            "External-code authorization code was rejected. Check it and try again.",
        },
      });
      expectNoSecrets(rejected.body, reconnect.sessionToken);
      await expectAccounts(actor, expected);
      mockNow(deadline + 1);
      await expectExpiredSession(actor, reconnect);
      await expectExpiredSession(actor, reconnect);
      await expectAccounts(actor, expected);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connector.id,
      });

      const recoveredAt = now();
      const recovery = await connectors.startExternalCode(actor, "aws", "cli", {
        intent: "reconnect",
        connectionId: siblingAccount.connector.id,
      });
      await expect(completeSession(actor, recovery)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expectExpiredSession(actor, reconnect);
      mockNow(recoveredAt + recovery.expiresIn * 1000 + 1);
      await expect(completeSession(actor, recovery)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expectAccounts(actor, expected);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connector.id,
      });
    });
  });

  it("keeps completing sessions exclusive at the strict stale boundary then expires without publishing the late successful account", async () => {
    const provider = mockAwsDeferredTokenExchange();
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const startedAt = now();
      mockNow(startedAt);
      const session = await connectors.startExternalCode(actor, "aws", "cli", {
        intent: "add",
      });
      const deadline = startedAt + session.expiresIn * 1000;
      const staleBoundary = startedAt + 30 * 60_000;
      expect(deadline).toBeLessThan(staleBoundary);
      const inFlight = connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(session),
        [500],
      );
      onTestFinished(async () => {
        provider.releaseTokenResponse();
        await inFlight;
      });
      await (async () => {
        await Promise.race([
          provider.tokenRequestStarted,
          inFlight.then(() => {
            throw new Error(
              "Completion finished before the AWS exchange started",
            );
          }),
        ]);
        for (const boundary of [deadline, deadline + 1, staleBoundary]) {
          mockNow(boundary);
          await expectCompletingSession(actor, session);
          await expectAccounts(actor, []);
        }
        mockNow(staleBoundary + 1);
        await expectExpiredSession(actor, session);
        await expectExpiredSession(actor, session);
        provider.releaseTokenResponse();
        const late = await inFlight;
        expect(late.status).toBe(500);
        expect(late.body).toStrictEqual({ error: "Internal server error" });
        expectNoSecrets(late.body, session.sessionToken);
        await expectExpiredSession(actor, session);
        await expectAccounts(actor, []);
      })().finally(() => {
        provider.releaseTokenResponse();
      });
    });
  });
});
