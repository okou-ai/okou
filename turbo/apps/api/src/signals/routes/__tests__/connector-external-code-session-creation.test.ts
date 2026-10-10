import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
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

function createActor(beforeDrain?: () => void) {
  mockAwsExternalCodeProvider();
  return createPublicConnectorActor(context, { beforeDrain });
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
  for (const secret of [
    session.sessionToken,
    "aws-secret-access-key",
    "aws-login-refresh-token",
    "aws-session-token",
    "aws-id-token",
  ]) {
    expect(JSON.stringify(completed)).not.toContain(secret);
  }
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

describe("Builtin external-code session creation", () => {
  it("replaces matching pending sessions while preserving completed replay, another workspace and the chosen non-default account", async () => {
    const owned = createActor();
    const foreign = createActor();
    expect(owned.actor.orgId).not.toBe(foreign.actor.orgId);
    await owned.run(async () => {
      await foreign.run(async () => {
        const actor = owned.actor;
        owned.ownsFeatureSwitches();
        foreign.ownsFeatureSwitches();
        await connectors.updateFeatureSwitches(actor, {});
        await connectors.updateFeatureSwitches(foreign.actor, {});
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
        expect(siblingAccount.connector.id).not.toBe(
          defaultAccount.connector.id,
        );
        const choice = {
          intent: "reconnect",
          connectionId: siblingAccount.connector.id,
        } as const;
        const pending = await connectors.startExternalCode(
          actor,
          "aws",
          "cli",
          choice,
        );
        const foreignPending = await connectors.startExternalCode(
          foreign.actor,
          "aws",
          "cli",
        );
        const replacement = await connectors.startExternalCode(
          actor,
          "aws",
          "cli",
          choice,
        );
        expect(replacement.sessionId).not.toBe(pending.sessionId);
        expect(replacement.sessionToken).not.toBe(pending.sessionToken);
        const superseded = await connectors.requestExternalCodeComplete(
          actor,
          "aws",
          completionInput(pending),
          [400],
        );
        expect(superseded.body).toStrictEqual({
          error: {
            code: "BAD_REQUEST",
            message: "External-code authorization session was superseded",
          },
        });
        await expect(
          completeSession(actor, defaultSession),
        ).resolves.toMatchObject({
          connector: { id: defaultAccount.connector.id },
        });
        const foreignAccount = await completeSession(
          foreign.actor,
          foreignPending,
        );
        const foreignReconnect = await connectors.requestExternalCodeStart(
          actor,
          "aws",
          "cli",
          [404],
          { intent: "reconnect", connectionId: foreignAccount.connector.id },
        );
        expect(foreignReconnect.body).toStrictEqual({
          error: { code: "NOT_FOUND", message: "Connector account not found" },
        });
        await expect(
          completeSession(actor, replacement),
        ).resolves.toMatchObject({
          connector: { id: siblingAccount.connector.id },
        });
        await expectAccounts(actor, [
          { id: defaultAccount.connector.id, isDefault: true },
          { id: siblingAccount.connector.id, isDefault: false },
        ]);
        await expectAccounts(foreign.actor, [
          { id: foreignAccount.connector.id, isDefault: true },
        ]);
      });
    });
  });

  it("rejects reconnect to a deleted account without retiring a previously usable pending session", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const defaultAccount = await completeSession(
        actor,
        await connectors.startExternalCode(actor, "aws", "cli"),
      );
      const siblingAccount = await completeSession(
        actor,
        await connectors.startExternalCode(actor, "aws", "cli"),
      );
      const deletedAccount = await completeSession(
        actor,
        await connectors.startExternalCode(actor, "aws", "cli"),
      );
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "aws",
        deletedAccount.connector.id,
      );
      const pending = await connectors.startExternalCode(actor, "aws", "cli", {
        intent: "reconnect",
        connectionId: siblingAccount.connector.id,
      });
      const rejected = await connectors.requestExternalCodeStart(
        actor,
        "aws",
        "cli",
        [404],
        { intent: "reconnect", connectionId: deletedAccount.connector.id },
      );
      expect(rejected.body).toStrictEqual({
        error: { code: "NOT_FOUND", message: "Connector account not found" },
      });
      await expect(completeSession(actor, pending)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expectAccounts(actor, [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ]);
    });
  });

  it("keeps an in-flight provider completion usable when a replacement session is started", async () => {
    let provider: ReturnType<typeof mockAwsDeferredTokenExchange> | undefined;
    const owned = createActor(() => {
      provider?.releaseTokenResponse();
    });
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const defaultAccount = await completeSession(
        actor,
        await connectors.startExternalCode(actor, "aws", "cli"),
      );
      const siblingAccount = await completeSession(
        actor,
        await connectors.startExternalCode(actor, "aws", "cli"),
      );
      const choice = {
        intent: "reconnect",
        connectionId: siblingAccount.connector.id,
      } as const;
      const pending = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        choice,
      );
      provider = mockAwsDeferredTokenExchange();
      const inFlight = owned.run(() => {
        return completeSession(actor, pending);
      });
      await Promise.race([
        provider.tokenRequestStarted,
        inFlight.then(() => {
          throw new Error("Completion finished before AWS exchange started");
        }),
      ]);
      const replacement = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        choice,
      );
      const completing = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(pending),
        [400],
      );
      expect(completing.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: "External-code authorization session is already completing",
        },
      });
      provider.releaseTokenResponse();
      await expect(inFlight).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expect(completeSession(actor, replacement)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expect(completeSession(actor, pending)).resolves.toMatchObject({
        connector: { id: siblingAccount.connector.id },
      });
      await expectAccounts(actor, [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ]);
    });
  });
});
