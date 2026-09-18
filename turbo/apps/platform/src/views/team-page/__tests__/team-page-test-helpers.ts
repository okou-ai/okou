import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/user-permission-grants";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const RESEARCH_AGENT_ID = "10000000-0000-4000-8000-000000000001";
export const SUPPORT_AGENT_ID = "10000000-0000-4000-8000-000000000002";
export const ARCHIVED_AGENT_ID = "10000000-0000-4000-8000-000000000003";
const ACME_CONNECTOR_ID = "20000000-0000-4000-8000-000000000001";
const DEEPWIKI_CONNECTOR_ID = "20000000-0000-4000-8000-000000000002";

const NOW = "2026-08-18T12:00:00.000Z";

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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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
  return {
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
    connection: {
      id: crypto.randomUUID(),
      authMethod: "oauth",
      externalUsername: options.externalUsername ?? null,
      externalEmail: null,
      reconnectReason: null,
    },
    connected: true,
    connectionStatus: "connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: true,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
}

function customConnectorBase() {
  return {
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "manual" as const,
    skillMarkdown: null,
    storageVersion: 1,
    connected: true,
    connectedAccountId: "30000000-0000-4000-8000-000000000001",
    connectedAccountUpdatedAt: NOW,
    missingRequiredFields: [],
    configuredFieldKeys: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function acmeConnectorFixture(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return customConnectorHttpResponseSchema.parse({
    ...customConnectorBase(),
    id: ACME_CONNECTOR_ID,
    slug: "acme-search",
    displayName: "Acme Search",
    kind: "http",
    prefixTemplates: ["https://api.acme.test/v1/"],
    permissionBundleRef: null,
    ...overrides,
  });
}

export function deepWikiConnectorFixture(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return customConnectorMcpResponseSchema.parse({
    ...customConnectorBase(),
    id: DEEPWIKI_CONNECTOR_ID,
    slug: "deepwiki",
    displayName: "DeepWiki",
    kind: "mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
    transport: "streamable-http",
    prefixTemplates: [],
    permissionBundleRef: null,
    ...overrides,
  });
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

export function permissionGrantFixture(
  connectorSlug: ConnectorSlug,
  permission: string,
  action: "allow" | "deny",
  expiresAt: string | null,
  overrides: Partial<UserPermissionGrantResponse> = {},
): UserPermissionGrantResponse {
  return {
    agentId: RESEARCH_AGENT_ID,
    connectorSlug,
    permission,
    action,
    expiresAt,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
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
