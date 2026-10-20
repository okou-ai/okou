import { describe, expect, it } from "vitest";

import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "../connector-accounts";
import { chatThreadConnectorSelectionContract } from "../chat-threads";
import { mcpConnectorsContract } from "../mcp-connectors";

const connectionId = "11111111-1111-4111-8111-111111111111";
const targets: readonly ConnectorAccountTarget[] = [
  { kind: "builtin", connectorSlug: "github" },
  { kind: "custom", customConnectorId: "22222222-2222-4222-8222-222222222222" },
];

function payloads(target: ConnectorAccountTarget, setup: object) {
  const brief = {
    id: connectionId,
    authMethod: "oauth",
    displayName: "Work",
    externalId: null,
    externalUsername: "work-user",
    externalEmail: null,
    connectionStatus: "connected",
    ...setup,
  };
  const account = {
    ...brief,
    target,
    isDefault: true,
    oauthScopes: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
  const { id: _id, ...identity } = brief;
  return {
    account,
    inspection: {
      ...identity,
      kind: "available",
      connectionId,
      target,
      reconnectReason: null,
    },
    mcp: {
      target,
      connectionId,
      slug: "example",
      displayName: "Example",
      transport: "streamable-http",
      endpoint: "https://mcp.example.test/server",
      connected: true,
      ...setup,
    },
  };
}

describe.each(targets)("$kind account reader preparation", (target) => {
  it.each([
    {},
    {
      setupStatus: "complete",
      missingRequiredFields: [],
      configuredFieldKeys: ["token"],
    },
    {
      setupStatus: "incomplete",
      missingRequiredFields: ["token"],
      configuredFieldKeys: [],
    },
    {
      setupStatus: "invalid",
      missingRequiredFields: [],
      configuredFieldKeys: ["token"],
    },
  ])("retains old or additive setup metadata without defaults: %j", (setup) => {
    const { account, inspection, mcp } = payloads(target, setup);
    const summary = {
      target,
      accountCount: 1,
      attentionCount: 0,
      defaultConnection: account,
    };
    expect(
      connectorAccountsContract.connections.responses[200].parse({
        connections: [account],
        nextCursor: null,
        defaultConnection: account,
      }),
    ).toStrictEqual({
      connections: [account],
      nextCursor: null,
      defaultConnection: account,
    });
    expect(
      connectorAccountsContract.summaries.responses[200].parse({
        summaries: [summary],
      }),
    ).toStrictEqual({ summaries: [summary] });
    expect(
      chatThreadConnectorSelectionContract.get.responses[200].parse({
        selections: [{ connectionId, target }],
        selectedConnections: [account],
      }),
    ).toStrictEqual({
      selections: [{ connectionId, target }],
      selectedConnections: [account],
    });
    expect(
      connectorAccountsContract.inspect.responses[200].parse({
        results: [inspection],
      }),
    ).toStrictEqual({ results: [inspection] });
    expect(
      mcpConnectorsContract.list.responses[200].parse({ connectors: [mcp] }),
    ).toStrictEqual({ connectors: [mcp] });
    const admitted = { ...mcp, connectionStatus: "reconnect-required" };
    expect(
      mcpConnectorsContract.list.responses[200].parse({
        connectors: [admitted],
      }),
    ).toStrictEqual({ connectors: [admitted] });
  });

  it.each([
    { setupStatus: "unknown" },
    { setupStatus: null },
    { missingRequiredFields: "token" },
    { configuredFieldKeys: [42] },
  ])("rejects malformed account metadata: %j", (setup) => {
    const { account, inspection, mcp } = payloads(target, setup);
    expect(
      connectorAccountsContract.connections.responses[200].safeParse({
        connections: [account],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      connectorAccountsContract.inspect.responses[200].safeParse({
        results: [inspection],
      }).success,
    ).toBe(false);
    expect(
      mcpConnectorsContract.list.responses[200].safeParse({ connectors: [mcp] })
        .success,
    ).toBe(false);
  });

  it("keeps unrelated fields and unavailable inspection details out of strict account responses", () => {
    const { account } = payloads(target, {});
    expect(
      connectorAccountsContract.connections.responses[200].safeParse({
        connections: [{ ...account, accessToken: "secret" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      connectorAccountsContract.inspect.responses[200].safeParse({
        results: [
          {
            kind: "unavailable",
            connectionId,
            target,
            setupStatus: "complete",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
