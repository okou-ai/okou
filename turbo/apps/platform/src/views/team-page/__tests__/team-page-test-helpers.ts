import {
  catalogFixture,
  connectorFixtureAccount,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function catalogConnectorFixture(
  slug: ConnectorSlug,
  label: string,
  options: {
    readonly externalUsername?: string;
    readonly hasPermissions?: boolean;
    readonly permissionCount?: number;
  } = {},
): PublicConnectorCatalogStatusItem {
  const hasPermissions = options.hasPermissions ?? true;
  return catalogFixture({
    slug,
    label,
    description: `${label} connected service`,
    icon: {
      url: `https://assets.test/${slug}.svg`,
      invertInDarkMode: false,
    },
    category: "productivity",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions,
      permissionCount: options.permissionCount ?? (hasPermissions ? 1 : 0),
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
    account: {
      id: crypto.randomUUID(),
      authMethod: "oauth",
      externalUsername: options.externalUsername ?? null,
      externalEmail: null,
      reconnectReason: null,
      connectionStatus: "connected",
      scopeMismatch: false,
      tokenExpiresAt: null,
    },
  });
}

/** Serves saved connector membership independently of default-account readiness. */
export function mockConnectorOverview(
  testContextValue: TestContext,
  connectors: readonly PublicConnectorCatalogStatusItem[],
  options: {
    readonly customConnectors?: readonly CustomConnectorResponse[];
    readonly connectedCustomConnectorIds?: readonly string[];
  } = {},
): void {
  testContextValue.mocks.api(
    connectedConnectorsContract.list,
    ({ respond }) => {
      return respond(200, {
        builtinConnectors: connectors
          .filter((connector) => {
            return connectorFixtureAccount(connector) !== undefined;
          })
          .map((connector) => {
            return {
              slug: connector.slug,
              label: connector.label,
              icon: connector.icon,
              hasPermissions: connector.permissionSummary.hasPermissions,
            };
          }),
        customConnectors: (options.customConnectors ?? [])
          .filter((connector) => {
            return options.connectedCustomConnectorIds
              ? options.connectedCustomConnectorIds.includes(connector.id)
              : isIntegrationManagedCustomConnector(connector)
                ? connector.connected
                : connectorFixtureAccount(connector) !== undefined;
          })
          .map((connector) => {
            return {
              id: connector.id,
              slug: connector.slug,
              displayName: connector.displayName,
              permissionBundleRef: connector.permissionBundleRef ?? null,
              integrationManaged:
                isIntegrationManagedCustomConnector(connector),
            };
          }),
      });
    },
  );
}

export function permissionMetadataFixture(
  connectorSlug: ConnectorSlug,
  label: string,
  permissions: readonly string[],
  options: {
    readonly categories?: Record<string, string> | null;
    readonly displayOrder?: readonly string[];
    readonly permissionDefault?: "allow" | "ask" | "deny";
    readonly permissionOverrides?: Record<string, string[]>;
    readonly unknownPolicy?: "allow" | "ask" | "deny";
  } = {},
): PublicConnectorCatalogPermissionDetail {
  const categories = options.categories;
  return {
    connectorSlug,
    label,
    icon: {
      url: `https://assets.test/${connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: permissions.length,
    permissions: permissions.map((name) => {
      return { name, description: `${name} permission` };
    }),
    categories:
      categories === undefined || categories === null
        ? null
        : {
            categories,
            displayOrder: [...(options.displayOrder ?? [])],
          },
    defaultPolicy: {
      permissionDefault: options.permissionDefault ?? "deny",
      ...(options.permissionOverrides
        ? { permissionOverrides: options.permissionOverrides }
        : {}),
      unknownPolicy: options.unknownPolicy ?? "deny",
    },
  };
}
