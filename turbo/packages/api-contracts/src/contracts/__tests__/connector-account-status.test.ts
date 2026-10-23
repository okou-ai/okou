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
    reconnectReason: null,
    ...setup,
  };
  const account = {
    ...brief,
    target,
    isDefault: true,
    oauthScopes: [],
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
    },
    mcp: {
      target,
      connectionId,
      slug: "example",
      displayName: "Example",
      transport: "streamable-http",
      endpoint: "https://mcp.example.test/server",
      runtimeAvailable: true,
      connectionStatus: "connected",
      reconnectReason: null,
      ...setup,
    },
  };
}

describe.each(targets)("$kind account status", (target) => {
  it.each([
    {
      missingRequiredFields: [],
      configuredFieldKeys: ["token"],
    },
    {
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_incomplete",
      missingRequiredFields: ["token"],
      configuredFieldKeys: [],
    },
    {
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_invalid",
      missingRequiredFields: [],
      configuredFieldKeys: ["token"],
    },
  ])("preserves canonical account status and field metadata: %j", (setup) => {
    const { account, inspection, mcp } = payloads(target, setup);
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
});
