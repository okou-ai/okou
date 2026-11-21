import {
  catalogFixture,
  connectorFixtureAccount,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const RESEARCH_AGENT_ID = "10000000-0000-4000-8000-000000000001";

export function agentFixture(
  agentId: string,
  displayName: string,
  overrides: Partial<AgentResponse> = {},
): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: "test-user-123",
    description: `${displayName} description`,
    displayName,
    sound: "professional",
    avatarUrl: null,
    visibility: "public",
    ...overrides,
  };
}

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

interface SetupTeamPageOptions {
  readonly context: TestContext;
  readonly path: string;
  readonly agents?: readonly AgentResponse[];
  readonly detailErrorByAgentId?: Readonly<Record<string, string>>;
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  readonly onDeleteAgent?: (agentId: string) => void;
}

export function setupTeamPage({
  context,
  path,
  agents = [agentFixture(RESEARCH_AGENT_ID, "Research Agent")],
  detailErrorByAgentId = {},
  featureSwitches,
  onDeleteAgent,
}: SetupTeamPageOptions): Promise<void> {
  let visibleAgents = [...agents];
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, visibleAgents);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const error = detailErrorByAgentId[params.id];
    if (error) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: error },
      });
    }
    const agent = visibleAgents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    return agent
      ? respond(200, agent)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Agent not found" },
        });
  });
  context.mocks.api(agentsByIdContract.delete, ({ params, respond }) => {
    visibleAgents = visibleAgents.filter((agent) => {
      return agent.agentId !== params.id;
    });
    onDeleteAgent?.(params.id);
    return respond(204);
  });

  return setupPage({ context, path, featureSwitches });
}
