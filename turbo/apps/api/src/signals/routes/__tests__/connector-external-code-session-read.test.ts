import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

async function prepareActor(): Promise<ApiTestUser> {
  const actor = bdd.user();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  mockAwsExternalCodeProvider();
  onTestFinished(async () => {
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "aws",
    );
    for (const account of accounts) {
      await connectors.deleteBuiltinConnectorAccount(actor, "aws", account.id);
    }
    await connectors.updateFeatureSwitches(actor, {});
  });
  await connectors.updateFeatureSwitches(actor, {});
  return actor;
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

function expectNoSecrets(body: unknown, tokens: readonly string[]): void {
  const serialized = JSON.stringify(body);
  for (const secret of [
    ...tokens,
    "aws-secret-access-key",
    "aws-login-refresh-token",
    "aws-session-token",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function expectSessionNotFound(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
  sessionToken: string,
): Promise<void> {
  const response = await connectors.requestExternalCodeComplete(
    actor,
    connectorSlug,
    { ...completionInput(session), sessionToken },
    [404],
  );
  expect(response.body).toStrictEqual({
    error: {
      code: "NOT_FOUND",
      message: "External-code authorization session not found",
    },
  });
  expectNoSecrets(response.body, [session.sessionToken, sessionToken]);
}

async function expectSuperseded(
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
      message: "External-code authorization session was superseded",
    },
  });
  expectNoSecrets(response.body, [session.sessionToken]);
}

async function expectIdentityBoundaries(
  actor: ApiTestUser,
  peer: ApiTestUser,
  foreignOrg: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
): Promise<void> {
  await expectSessionNotFound(
    actor,
    "aws",
    session,
    `wrong-${session.sessionToken}`,
  );
  await expectSessionNotFound(actor, "github", session, session.sessionToken);
  await expectSessionNotFound(peer, "aws", session, session.sessionToken);
  await expectSessionNotFound(foreignOrg, "aws", session, session.sessionToken);
}

async function expectReplay(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
  connectionId: string,
): Promise<void> {
  const replay = await connectors.completeExternalCode(
    actor,
    "aws",
    completionInput(session),
  );
  expect(replay).toMatchObject({
    status: "complete",
    connector: {
      id: connectionId,
      slug: "aws",
      authMethod: "cli",
      connectionStatus: "connected",
    },
  });
  expectNoSecrets(replay, [session.sessionToken]);
}

describe("external-code owned-session read", () => {
  it("rejects each real-session identity boundary before and after completion", async () => {
    const actor = await prepareActor();
    const peer = bdd.user({ orgId: actor.orgId });
    const foreignOrg = bdd.user({ userId: actor.userId });
    expect(peer.userId).not.toBe(actor.userId);
    expect(peer.orgId).toBe(actor.orgId);
    expect(foreignOrg.userId).toBe(actor.userId);
    expect(foreignOrg.orgId).not.toBe(actor.orgId);

    const session = await connectors.startExternalCode(actor, "aws", "cli", {
      intent: "add",
    });
    await expectIdentityBoundaries(actor, peer, foreignOrg, session);
    await expect(
      connectors.listBuiltinConnectorAccounts(actor, "aws"),
    ).resolves.toStrictEqual([]);

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
    expectNoSecrets(completed, [session.sessionToken]);
    const readBack = await connectors.readConnectorBySlug(actor, "aws");
    expect(readBack).toMatchObject({
      id: completed.connector.id,
      slug: "aws",
      authMethod: "cli",
    });

    await expectIdentityBoundaries(actor, peer, foreignOrg, session);
    await expectReplay(actor, session, completed.connector.id);
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "aws",
    );
    expect(
      accounts.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([completed.connector.id]);
  });

  it("requires each exact token across real supersession and completed-account replay", async () => {
    const actor = await prepareActor();
    const first = await connectors.startExternalCode(actor, "aws", "cli", {
      intent: "add",
    });
    const latest = await connectors.startExternalCode(actor, "aws", "cli", {
      intent: "add",
    });
    expect(first.sessionId).not.toBe(latest.sessionId);
    expect(first.sessionToken).not.toBe(latest.sessionToken);

    await expectSessionNotFound(actor, "aws", first, latest.sessionToken);
    await expectSessionNotFound(actor, "aws", latest, first.sessionToken);
    await expectSuperseded(actor, first);
    await expect(
      connectors.listBuiltinConnectorAccounts(actor, "aws"),
    ).resolves.toStrictEqual([]);

    const completed = await connectors.completeExternalCode(
      actor,
      "aws",
      completionInput(latest),
    );
    expect(completed).toMatchObject({
      status: "complete",
      connector: {
        slug: "aws",
        authMethod: "cli",
        connectionStatus: "connected",
      },
    });
    expectNoSecrets(completed, [first.sessionToken, latest.sessionToken]);
    await expectSessionNotFound(actor, "aws", first, latest.sessionToken);
    await expectSessionNotFound(actor, "aws", latest, first.sessionToken);
    await expectSuperseded(actor, first);
    await expectReplay(actor, latest, completed.connector.id);
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "aws",
    );
    expect(
      accounts.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([completed.connector.id]);
  });
});
