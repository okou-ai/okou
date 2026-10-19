import {
  type ConnectorAccountConnection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import type { PublicConnectorCatalogStatusItem } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";

export function connectorAccount(
  target: ConnectorAccountTarget,
  overrides: Partial<ConnectorAccountConnection> = {},
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target,
    authMethod: "oauth",
    displayName: null,
    isDefault: true,
    externalId: "provider-account",
    externalUsername: "member",
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

export function connectorAccountSummary(
  target: ConnectorAccountTarget,
  accounts: readonly ConnectorAccountConnection[],
): ConnectorAccountSummary {
  return {
    target,
    accountCount: accounts.length,
    attentionCount: accounts.filter((account) => {
      return account.connectionStatus === "reconnect-required";
    }).length,
    defaultConnection:
      accounts.find((account) => {
        return account.isDefault;
      }) ?? null,
  };
}

export function stubConnectorAccountSummaries(
  summaries: readonly ConnectorAccountSummary[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/connector-accounts`, () => {
    return HttpResponse.json({ summaries });
  });
}

export function catalogAccountSummaries(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): readonly ConnectorAccountSummary[] {
  return connectors.flatMap((connector) => {
    if (!connector.connection) return [];
    const target = { kind: "builtin", connectorSlug: connector.slug } as const;
    return [
      connectorAccountSummary(target, [
        connectorAccount(target, {
          id: connector.connection.id ?? crypto.randomUUID(),
          authMethod: connector.connection.authMethod,
          externalUsername: connector.connection.externalUsername,
          externalEmail: connector.connection.externalEmail,
          connectionStatus:
            connector.connectionStatus === "reconnect-required"
              ? "reconnect-required"
              : "connected",
          reconnectReason: connector.connection.reconnectReason,
          tokenExpiresAt: connector.tokenExpiresAt,
        }),
      ]),
    ];
  });
}

export function customAccountSummaries(
  connectors: readonly CustomConnectorResponse[],
): readonly ConnectorAccountSummary[] {
  return connectors.flatMap((connector) => {
    if (
      isIntegrationManagedCustomConnector(connector) ||
      !connector.connectedAccountId
    )
      return [];
    const target = { kind: "custom", customConnectorId: connector.id } as const;
    return [
      connectorAccountSummary(target, [
        connectorAccount(target, {
          id: connector.connectedAccountId,
          authMethod: connector.authMode,
          externalId: null,
          externalUsername: null,
        }),
      ]),
    ];
  });
}
