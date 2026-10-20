import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsDeferredTokenExchange,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createExternalCodeProviderFixture } from "./helpers/external-code-provider-fixture";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

beforeEach(mockSecretKmsHttp);

async function prepareActor() {
  const actor = bdd.user();
  const providerFixture = createExternalCodeProviderFixture(context, actor);
  mockAwsExternalCodeProvider();
  const owner = createFixtureOperationOwner(async () => {
    const flagsDeleted = await settleIncludingAbort(
      connectors.deleteFeatureSwitches(actor),
    );
    await providerFixture.restore();
    if (!flagsDeleted.ok) {
      throw flagsDeleted.error;
    }
  });
  await owner.run(() => {
    return connectors.updateFeatureSwitches(actor, {});
  });
  return {
    actor,
    run: owner.run,
    expectConnectorChanged: providerFixture.expectConnectorChanged,
  };
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
    account: {
      id: connectionId,
      target: { kind: "builtin", connectorSlug: "aws" },
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
    const { actor, run, expectConnectorChanged } = await prepareActor();
    const defaultSession = await run(() => {
      return connectors.startExternalCode(actor, "aws", "cli", {
        intent: "add",
      });
    });
    const defaultAccount = await run(() => {
      return connectors.completeExternalCode(
        actor,
        "aws",
        completionInput(defaultSession),
      );
    });
    await run(expectConnectorChanged);
    const siblingSession = await run(() => {
      return connectors.startExternalCode(actor, "aws", "cli", {
        intent: "add",
      });
    });
    const siblingAccount = await run(() => {
      return connectors.completeExternalCode(
        actor,
        "aws",
        completionInput(siblingSession),
      );
    });
    await run(expectConnectorChanged);
    expect(siblingAccount.connectionId).not.toBe(defaultAccount.connectionId);
    const expected = [
      { id: defaultAccount.connectionId, isDefault: true },
      { id: siblingAccount.connectionId, isDefault: false },
    ];
    await run(() => {
      return expectAccounts(actor, expected);
    });
    const reconnect = await run(() => {
      return connectors.startExternalCode(actor, "aws", "cli", {
        intent: "reconnect",
        connectionId: siblingAccount.connectionId,
      });
    });

    await run(() => {
      return expectProviderRejected(actor, reconnect);
    });
    await run(() => {
      return expectAccounts(actor, expected);
    });
    await run(() => {
      return expectDefault(actor, defaultAccount.connectionId);
    });
    const retried = await run(() => {
      return connectors.completeExternalCode(
        actor,
        "aws",
        completionInput(reconnect),
      );
    });
    await run(expectConnectorChanged);
    expect(retried).toMatchObject({
      status: "complete",
      account: {
        id: siblingAccount.connectionId,
        target: { kind: "builtin", connectorSlug: "aws" },
        authMethod: "cli",
        connectionStatus: "connected",
      },
    });
    expectNoSecrets(retried, reconnect.sessionToken);
    await run(() => {
      return expectReplay(actor, reconnect, siblingAccount.connectionId);
    });
    await run(() => {
      return expectAccounts(actor, expected);
    });
    await run(() => {
      return expectDefault(actor, defaultAccount.connectionId);
    });
  });

  it("keeps a reclaimed real session exclusive while enforcing each identity boundary", async () => {
    const { actor, run, expectConnectorChanged } = await prepareActor();
    const peer = bdd.user({ orgId: actor.orgId });
    const foreignOrg = bdd.user({ userId: actor.userId });
    expect(peer.userId).not.toBe(actor.userId);
    expect(peer.orgId).toBe(actor.orgId);
    expect(foreignOrg.userId).toBe(actor.userId);
    expect(foreignOrg.orgId).not.toBe(actor.orgId);
    const session = await run(() => {
      return connectors.startExternalCode(actor, "aws", "cli", {
        intent: "add",
      });
    });
    await run(() => {
      return expectProviderRejected(actor, session);
    });
    await run(() => {
      return expectAccounts(actor, []);
    });

    const provider = mockAwsDeferredTokenExchange();
    const inFlight = run(() => {
      return connectors.completeExternalCode(
        actor,
        "aws",
        completionInput(session),
      );
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
      await run(() => {
        return expectSessionNotFound(
          peer,
          "aws",
          session,
          session.sessionToken,
        );
      });
      await run(() => {
        return expectSessionNotFound(
          foreignOrg,
          "aws",
          session,
          session.sessionToken,
        );
      });
      await run(() => {
        return expectSessionNotFound(
          actor,
          "github",
          session,
          session.sessionToken,
        );
      });
      await run(() => {
        return expectSessionNotFound(
          actor,
          "aws",
          session,
          `wrong-${session.sessionToken}`,
        );
      });
      const duplicate = await run(() => {
        return connectors.requestExternalCodeComplete(
          actor,
          "aws",
          completionInput(session),
          [400],
        );
      });
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
    await run(expectConnectorChanged);
    expect(completed).toMatchObject({
      status: "complete",
      account: {
        target: { kind: "builtin", connectorSlug: "aws" },
        authMethod: "cli",
        connectionStatus: "connected",
      },
    });
    expectNoSecrets(completed, session.sessionToken);
    await run(() => {
      return expectReplay(actor, session, completed.connectionId);
    });
    await run(() => {
      return expectAccounts(actor, [
        { id: completed.connectionId, isDefault: true },
      ]);
    });
  });
});
