import {
  connectorAccountTargetSchema,
  connectorAccountListQuerySchema,
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { catalogFixtureAccount } from "./connector-catalog";
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
    ...(target.kind === "builtin" ? { scopeMismatch: false } : {}),
    connectionStatus: "connected",
    setupStatus: "complete",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

export function stubConnectorAccounts(
  accounts: readonly ConnectorAccountConnection[],
  origin = "http://localhost:3000",
) {
  return http.get(
    `${origin}/api/connector-accounts/connections`,
    ({ request }) => {
      const query = connectorAccountListQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const target: ConnectorAccountTarget =
        query.kind === "builtin"
          ? { kind: "builtin", connectorSlug: query.connectorSlug }
          : { kind: "custom", customConnectorId: query.customConnectorId };
      const connections = accounts.filter((account) => {
        return (
          connectorAccountTargetKey(account.target) ===
          connectorAccountTargetKey(target)
        );
      });
      return HttpResponse.json({
        connections,
        defaultConnection:
          connections.find((account) => {
            return account.isDefault;
          }) ?? null,
        nextCursor: null,
      });
    },
  );
}

export function stubConnectedConnectors(
  builtinSlugs: readonly string[] = [],
  customDefinitions: readonly CustomConnectorResponse[] = [],
) {
  return http.get("http://localhost:3000/api/connectors/connected", () => {
    return HttpResponse.json({
      builtinConnectors: builtinSlugs.map((slug) => {
        return {
          slug,
          label: slug,
          icon: {
            url: `https://icons.example.test/${slug}.svg`,
            invertInDarkMode: false,
          },
          hasPermissions: false,
        };
      }),
      customConnectors: customDefinitions.map((connector) => {
        return {
          id: connector.id,
          slug: connector.slug,
          displayName: connector.displayName,
          permissionBundleRef: connector.permissionBundleRef ?? null,
          integrationManaged: isIntegrationManagedCustomConnector(connector),
        };
      }),
    });
  });
}

export function stubConnectorAccountDetails(
  overrides: Partial<ConnectorAccountConnection> = {},
) {
  return http.get(
    "http://localhost:3000/api/connector-accounts/:connectionId",
    ({ request, params }) => {
      const target = connectorAccountTargetSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return HttpResponse.json(
        connectorAccount(target, {
          id: String(params.connectionId),
          ...overrides,
        }),
      );
    },
  );
}

export function catalogAccountConnections(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): readonly ConnectorAccountConnection[] {
  return connectors.flatMap((connector) => {
    const fixture = catalogFixtureAccount(connector);
    if (!fixture?.connection) return [];
    const target = { kind: "builtin", connectorSlug: connector.slug } as const;
    return [
      connectorAccount(target, {
        id: fixture.connection.id ?? crypto.randomUUID(),
        authMethod: fixture.connection.authMethod,
        externalUsername: fixture.connection.externalUsername,
        externalEmail: fixture.connection.externalEmail,
        connectionStatus:
          fixture.connectionStatus === "reconnect-required"
            ? "reconnect-required"
            : "connected",
        reconnectReason: fixture.connection.reconnectReason,
        scopeMismatch: fixture.scopeMismatch ?? false,
        tokenExpiresAt: fixture.tokenExpiresAt ?? null,
      }),
    ];
  });
}
