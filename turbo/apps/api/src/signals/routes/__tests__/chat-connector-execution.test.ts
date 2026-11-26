import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { runConnectorAccountRoutes } from "../run-connector-accounts";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatConnectorAccessRoutes,
    ...connectedConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsValuesSetRoutes,
    ...runConnectorAccountRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const selectionsApi = app(chatThreadConnectorSelectionContract);
const accessApi = app(chatConnectorAccessContract);
const customConnectorsApi = app(customConnectorsContract);
const customValuesApi = app(customConnectorValuesContract);
const runConnectorAccountsApi = app(runConnectorAccountsContract);

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  return headers;
}

function manualMcpBody(displayName: string) {
  return {
    kind: "mcp" as const,
    displayName,
    endpoint: `https://mcp-${randomUUID()}.example.test/mcp`,
    transport: "streamable-http" as const,
    authMode: "manual" as const,
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret" as const,
        required: true,
      },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
  };
}

async function setupMcpAccounts(withSibling = true) {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const ownerHeaders = signIn(ownerId, orgId);

  const [requestingChat, siblingChat, mcpConnector] = await Promise.all([
    accept(
      threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
      [201],
    ),
    withSibling
      ? accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        )
      : Promise.resolve(null),
    accept(
      customConnectorsApi.create({
        headers: ownerHeaders,
        body: manualMcpBody("Manual MCP"),
      }),
      [201],
    ),
  ]);

  const [fallbackAccount, requestedAccount] = await Promise.all([
    withSibling
      ? accept(
          customValuesApi.set({
            headers: ownerHeaders,
            params: { id: mcpConnector.body.id },
            body: {
              values: [
                { key: "secret", kind: "secret", value: `fb-${randomUUID()}` },
              ],
              account: { intent: "add", displayName: "Fallback" },
            },
          }),
          [200],
        )
      : Promise.resolve(null),
    accept(
      customValuesApi.set({
        headers: ownerHeaders,
        params: { id: mcpConnector.body.id },
        body: {
          values: [
            { key: "secret", kind: "secret", value: `req-${randomUUID()}` },
          ],
          account: { intent: "add", displayName: "Requested" },
        },
      }),
      [200],
    ),
  ]);

  const target = {
    kind: "custom" as const,
    customConnectorId: mcpConnector.body.id,
  };
  if (siblingChat && fallbackAccount) {
    await accept(
      selectionsApi.update({
        headers: ownerHeaders,
        params: { id: siblingChat.body.id },
        body: { target, connectionId: fallbackAccount.body.connectionId },
      }),
      [200],
    );
  }

  return {
    orgId,
    ownerId,
    ownerHeaders,
    requestingChatId: requestingChat.body.id,
    siblingChatId: siblingChat?.body.id ?? "",
    target,
    fallbackConnectionId: fallbackAccount?.body.connectionId ?? "",
    requestedConnectionId: requestedAccount.body.connectionId,
    requestedSelection: {
      target,
      connectionId: requestedAccount.body.connectionId,
    },
  };
}

describe("Chat connector execution", () => {
  it("chat-connector-execution-002 (1/3) rejects approval when switch is off, denies account, and rejects foreign Chat and mismatched target", async () => {
    const setup = await setupMcpAccounts(false);
    const otherId = `user_${randomUUID()}`;
    const mismatchedConnector = await accept(
      customConnectorsApi.create({
        headers: setup.ownerHeaders,
        body: manualMcpBody("Other MCP"),
      }),
      [201],
    );
    const otherChat = await accept(
      threadsApi.create({
        headers: signIn(otherId, setup.orgId),
        body: { model: null },
      }),
      [201],
    );

    const authHeaders = signIn(setup.ownerId, setup.orgId);
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [404],
    );

    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );

    const denied = await accept(
      accessApi.updateAccountPolicy({
        headers: signIn(setup.ownerId, setup.orgId),
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "deny" },
      }),
      [200],
    );
    expect(denied.body).toStrictEqual({
      connectionId: setup.requestedConnectionId,
      allowed: false,
      enabled: false,
      expiresAt: null,
    });

    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: otherChat.body.id },
        body: setup.requestedSelection,
      }),
      [404],
    );
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: {
          target: {
            kind: "custom",
            customConnectorId: mismatchedConnector.body.id,
          },
          connectionId: setup.requestedConnectionId,
        },
      }),
      [404],
    );
  });

  it("chat-connector-execution-002 (2/3) approves the exact account member-wide with 1h expiry and selects it only in the requesting Chat", async () => {
    const setup = await setupMcpAccounts(true);
    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );
    const authHeaders = signIn(setup.ownerId, setup.orgId);
    await accept(
      accessApi.updateAccountPolicy({
        headers: authHeaders,
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "deny" },
      }),
      [200],
    );

    const beforeApproveMs = now();
    const approved = await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [200],
    );
    expect(approved.body).toStrictEqual(setup.requestedSelection);

    const [requestingOverview, siblingOverview, policiesAfterApprove] =
      await Promise.all([
        accept(
          accessApi.overviewTarget({
            headers: authHeaders,
            query: { threadId: setup.requestingChatId, ...setup.target },
          }),
          [200],
        ),
        accept(
          accessApi.overviewTarget({
            headers: authHeaders,
            query: { threadId: setup.siblingChatId, ...setup.target },
          }),
          [200],
        ),
        accept(
          accessApi.accountPolicies({
            headers: authHeaders,
            query: setup.target,
          }),
          [200],
        ),
      ]);

    expect(requestingOverview.body.connector?.currentConnectionId).toBe(
      setup.requestedConnectionId,
    );
    expect(siblingOverview.body.connector?.currentConnectionId).toBe(
      setup.fallbackConnectionId,
    );
    expect(siblingOverview.body.connector?.accounts).toContainEqual(
      expect.objectContaining({
        connectionId: setup.requestedConnectionId,
        enabled: true,
      }),
    );

    const oneHourPolicy = policiesAfterApprove.body.find((entry) => {
      return entry.connectionId === setup.requestedConnectionId;
    });
    expect(oneHourPolicy).toMatchObject({
      connectionId: setup.requestedConnectionId,
      allowed: true,
      enabled: true,
    });
    expect(oneHourPolicy?.expiresAt).toBeTruthy();
    const expiresMs = Date.parse(oneHourPolicy?.expiresAt ?? "");
    expect(expiresMs - beforeApproveMs).toBeGreaterThanOrEqual(3_590_000);
    expect(expiresMs - beforeApproveMs).toBeLessThanOrEqual(3_610_000);
  });

  it("chat-connector-execution-002 (3/3) preserves an existing 24-hour policy on subsequent approval", async () => {
    const setup = await setupMcpAccounts(false);
    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );
    const authHeaders = signIn(setup.ownerId, setup.orgId);

    const allow24h = await accept(
      accessApi.updateAccountPolicy({
        headers: authHeaders,
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "allow-24h" },
      }),
      [200],
    );
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [200],
    );
    const policiesAfter24h = await accept(
      accessApi.accountPolicies({
        headers: authHeaders,
        query: setup.target,
      }),
      [200],
    );
    const persisted24h = policiesAfter24h.body.find((entry) => {
      return entry.connectionId === setup.requestedConnectionId;
    });
    expect(persisted24h).toStrictEqual(allow24h.body);
  });
});
