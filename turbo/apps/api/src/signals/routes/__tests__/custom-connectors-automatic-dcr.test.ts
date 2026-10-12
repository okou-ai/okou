import { randomUUID } from "node:crypto";

import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES } from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const connectors = createConnectorBddApi(context);

function configureProvider(
  options: Parameters<typeof mockAutomaticMcpOAuthProvider>[1] = {
    registration: "dcr",
  },
) {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  return mockAutomaticMcpOAuthProvider(context, options);
}

async function createConnector(actor: ApiTestUser, endpoint: string) {
  return await connectors.createCustomConnector(actor, {
    kind: "mcp",
    displayName: `Automatic DCR ${randomUUID()}`,
    endpoint,
    transport: "streamable-http",
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "automatic",
  });
}

async function completeAuthorization(authorization: string, issuer: string) {
  const state = new URL(authorization).searchParams.get("state");
  if (!state) {
    throw new Error("Expected custom OAuth authorization state");
  }
  const callback = await connectors.completeCustomConnectorOAuth2CallbackResult(
    {
      code: randomUUID(),
      state,
      iss: issuer,
    },
  );
  expect(callback.body.status).toBe("success");
}

async function connect(
  actor: ApiTestUser,
  connectorId: string,
  issuer: string,
  mutation: ConnectorAccountMutationIntent = { intent: "add" },
) {
  const authorization = await connectors.startCustomConnectorOAuth2(
    actor,
    connectorId,
    undefined,
    mutation,
  );
  await completeAuthorization(authorization, issuer);
  const [account] = await connectors.listCustomConnectorAccounts(
    actor,
    connectorId,
  );
  if (!account) {
    throw new Error("Expected authorized custom connector account");
  }
  return account;
}

describe("Custom Automatic OAuth DCR retirement", () => {
  it("replaces expired registrations with no linked accounts across repeated authorizations", async () => {
    const startedAt = now();
    mockNow(startedAt);
    const initial = configureProvider({
      registration: "dcr",
      dcrClientSecretExpiresAt: Math.floor((startedAt + 60_000) / 1000),
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createConnector(actor, initial.endpoint);
    await connectors.startCustomConnectorOAuth2(actor, connector.id);
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([]);

    mockNow(startedAt + 120_000);
    const second = configureProvider({
      registration: "dcr",
      dcrClientSecretExpiresAt: Math.floor((startedAt + 180_000) / 1000),
    });
    await connectors.startCustomConnectorOAuth2(actor, connector.id);
    expect(second.registrationBodies).toHaveLength(1);
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([]);

    mockNow(startedAt + 240_000);
    const third = configureProvider();
    const account = await connect(actor, connector.id, third.issuer);
    expect(account).toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });
    expect(third.registrationBodies).toHaveLength(1);
    await connectors.deleteCustomConnector(actor, connector.id);
  });

  it("marks only the expired registration's owners for reconnect and restores the selected account", async () => {
    const startedAt = now();
    mockNow(startedAt);
    const initial = configureProvider({
      registration: "dcr",
      dcrClientSecretExpiresAt: Math.floor((startedAt + 60_000) / 1000),
    });
    const bdd = createBddApi(context);
    const owner = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const peerOwner = bdd.user({ orgRole: "org:admin" });
    const connector = await createConnector(owner, initial.endpoint);
    const first = await connect(owner, connector.id, initial.issuer);
    const second = await connect(member, connector.id, initial.issuer);

    // The same issuer has independent registrations for other connectors/orgs.
    configureProvider();
    const sibling = await createConnector(owner, initial.endpoint);
    const siblingAccount = await connect(owner, sibling.id, initial.issuer);
    const peer = await createConnector(peerOwner, initial.endpoint);
    const peerAccount = await connect(peerOwner, peer.id, initial.issuer);
    const replacement = configureProvider();
    mockNow(startedAt + 120_000);
    await connectors.requestStartCustomConnectorOAuth2(
      peerOwner,
      connector.id,
      [404],
    );
    expect(replacement.registrationBodies).toHaveLength(0);
    const authorization = await connectors.startCustomConnectorOAuth2(
      owner,
      connector.id,
      undefined,
      {
        intent: "reconnect",
        connectionId: first.id,
      },
    );
    expect(replacement.registrationBodies).toHaveLength(1);

    for (const [actor, account] of [
      [owner, first],
      [member, second],
    ] as const) {
      await expect(
        connectors.listCustomConnectorAccounts(actor, connector.id),
      ).resolves.toMatchObject([
        {
          id: account.id,
          connectionStatus: "reconnect-required",
          reconnectReason: "authorization_expired_or_revoked",
          createdAt: account.createdAt,
          updatedAt: new Date(startedAt + 120_000).toISOString(),
        },
      ]);
    }
    await expect(
      connectors.listCustomConnectorAccounts(owner, sibling.id),
    ).resolves.toStrictEqual([siblingAccount]);
    await expect(
      connectors.listCustomConnectorAccounts(peerOwner, peer.id),
    ).resolves.toStrictEqual([peerAccount]);
    await completeAuthorization(authorization, replacement.issuer);
    await expect(
      connectors.listCustomConnectorAccounts(owner, connector.id),
    ).resolves.toMatchObject([
      { id: first.id, connectionStatus: "connected", reconnectReason: null },
    ]);
    await expect(
      connectors.listCustomConnectorAccounts(member, connector.id),
    ).resolves.toMatchObject([
      {
        id: second.id,
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      },
    ]);
    await connectors.deleteCustomConnector(owner, connector.id);
    await connectors.deleteCustomConnector(owner, sibling.id);
    await connectors.deleteCustomConnector(peerOwner, peer.id);
  });

  it("preserves connected accounts when replacement registration fails before retirement", async () => {
    const startedAt = now();
    mockNow(startedAt);
    const initial = configureProvider({
      registration: "dcr",
      dcrClientSecretExpiresAt: Math.floor((startedAt + 60_000) / 1000),
    });
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const connector = await createConnector(actor, initial.endpoint);
    const account = await connect(actor, connector.id, initial.issuer);
    mockNow(startedAt + 120_000);
    configureProvider({ registration: "dcr", dcrFailureStatus: 503 });
    const failed = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [502],
    );
    expect(failed.body).toMatchObject({
      error: {
        code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
      },
    });
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([account]);
    const replacement = configureProvider();
    await connect(actor, connector.id, replacement.issuer, {
      intent: "reconnect",
      connectionId: account.id,
    });
    expect(replacement.registrationBodies).toHaveLength(1);
    await connectors.deleteCustomConnector(actor, connector.id);
  });
});
