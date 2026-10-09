import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsDeferredTokenExchange,
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
    await connectors.deleteFeatureSwitches(actor);
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

async function expectProviderRejected(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
): Promise<void> {
  const rejected = await connectors.requestExternalCodeComplete(
    actor,
    "aws",
    {
      ...completionInput(session),
      code: awsVerificationCode(session.authorizationUrl, "AWS-BAD"),
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
  expectNoSecrets(rejected.body, session.sessionToken);
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
  expectNoSecrets(response.body, session.sessionToken);
  expectNoSecrets(response.body, sessionToken);
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(actor, "aws");
  const identities = accounts.map((account) => {
    return { id: account.id, isDefault: account.isDefault };
  });
  const byId = (a: { readonly id: string }, b: { readonly id: string }) => {
    return a.id.localeCompare(b.id);
  };
  expect(identities.sort(byId)).toStrictEqual([...expected].sort(byId));
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
  expectNoSecrets(replay, session.sessionToken);
}

async function expectDefault(actor: ApiTestUser, connectionId: string) {
  const account = await connectors.readConnectorBySlug(actor, "aws");
  expect(account.id).toBe(connectionId);
}

describe("external-code session claim ownership", () => {
  it("reclaims a rejected reconnect into the exact non-default account without changing its sibling", async () => {
    const actor = await prepareActor();
    const defaultSession = await connectors.startExternalCode(
      actor,
      "aws",
      "cli",
      {
        intent: "add",
      },
    );
    const defaultAccount = await connectors.completeExternalCode(
      actor,
      "aws",
      completionInput(defaultSession),
    );
    const siblingSession = await connectors.startExternalCode(
      actor,
      "aws",
      "cli",
      {
        intent: "add",
      },
    );
    const siblingAccount = await connectors.completeExternalCode(
      actor,
      "aws",
      completionInput(siblingSession),
    );
    expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
    const expected = [
      { id: defaultAccount.connector.id, isDefault: true },
      { id: siblingAccount.connector.id, isDefault: false },
    ];
    await expectAccounts(actor, expected);
    const reconnect = await connectors.startExternalCode(actor, "aws", "cli", {
      intent: "reconnect",
      connectionId: siblingAccount.connector.id,
    });

    await expectProviderRejected(actor, reconnect);
    await expectAccounts(actor, expected);
    await expectDefault(actor, defaultAccount.connector.id);
    const retried = await connectors.completeExternalCode(
      actor,
      "aws",
      completionInput(reconnect),
    );
    expect(retried).toMatchObject({
      status: "complete",
      connector: {
        id: siblingAccount.connector.id,
        slug: "aws",
        authMethod: "cli",
        connectionStatus: "connected",
      },
    });
    expectNoSecrets(retried, reconnect.sessionToken);
    await expectReplay(actor, reconnect, siblingAccount.connector.id);
    await expectAccounts(actor, expected);
    await expectDefault(actor, defaultAccount.connector.id);
  });

  it("keeps a reclaimed real session exclusive while enforcing each identity boundary", async () => {
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
    await expectProviderRejected(actor, session);
    await expectAccounts(actor, []);

    const provider = mockAwsDeferredTokenExchange();
    const inFlight = connectors.completeExternalCode(
      actor,
      "aws",
      completionInput(session),
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
      await expectSessionNotFound(peer, "aws", session, session.sessionToken);
      await expectSessionNotFound(
        foreignOrg,
        "aws",
        session,
        session.sessionToken,
      );
      await expectSessionNotFound(
        actor,
        "github",
        session,
        session.sessionToken,
      );
      await expectSessionNotFound(
        actor,
        "aws",
        session,
        `wrong-${session.sessionToken}`,
      );
      const duplicate = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(session),
        [400],
      );
      expect(duplicate.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: "External-code authorization session is already completing",
        },
      });
      expectNoSecrets(duplicate.body, session.sessionToken);
    })().finally(() => {
      provider.releaseTokenResponse();
    });
    const completed = await inFlight;
    expect(completed).toMatchObject({
      status: "complete",
      connector: {
        slug: "aws",
        authMethod: "cli",
        connectionStatus: "connected",
      },
    });
    expectNoSecrets(completed, session.sessionToken);
    await expectReplay(actor, session, completed.connector.id);
    await expectAccounts(actor, [
      { id: completed.connector.id, isDefault: true },
    ]);
  });
});
