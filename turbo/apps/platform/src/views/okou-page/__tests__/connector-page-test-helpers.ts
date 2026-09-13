import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type PublicConnectorCatalogCategoryMetadata,
  type PublicConnectorCatalogStatusItem,
  connectorCatalogContract,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  type CreateCustomConnectorBody,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  customConnectorByIdContract,
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, within } from "@testing-library/react";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function mockOAuthCompletions(
  context: TestContext,
): Map<string, string> {
  const completed = new Map<string, string>();
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    ({ params, respond }) => {
      const connectionId = completed.get(params.attemptId);
      return connectionId
        ? respond(200, { connectionId })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "OAuth completion not found" },
          });
    },
  );
  return completed;
}

export function getConnectorAction(
  role: "button" | "link" | "menuitem" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryConnectorAction(role, name, container);
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

export function queryConnectorAction(
  role: "button" | "link" | "menuitem" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

export function getConnectorSwitch(
  name: string,
  container: HTMLElement = document.body,
): HTMLElement {
  return within(container).getByRole("switch", { name });
}

export function queryConnectorCard(label: string): HTMLElement | null {
  const labelElement = screen
    .queryAllByTestId("connector-card-label")
    .find((element) => {
      return element.textContent === label;
    });
  const card = labelElement?.closest('[data-slot="connector-card"]');
  if (labelElement && !(card instanceof HTMLElement)) {
    throw new Error(`${label} connector card label has no card container`);
  }
  return card instanceof HTMLElement ? card : null;
}

export function getConnectorCard(label: string): HTMLElement {
  const card = queryConnectorCard(label);
  if (!card) {
    throw new Error(`Expected connector card "${label}"`);
  }
  return card;
}

export function getConnectorIcon(label: string): HTMLImageElement {
  const icon = getConnectorCard(label).querySelector("img");
  if (!(icon instanceof HTMLImageElement)) {
    throw new Error(`Expected connector icon "${label}"`);
  }
  return icon;
}

export function listAgent(
  agentId: string,
  displayName: string,
  avatarUrl: string | null = null,
): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

export function mockConnectors(
  context: TestContext,
  connectors: readonly {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod?: ConnectorAuthMethodId;
    readonly externalUsername?: string;
    readonly connectionStatus?: ConnectorResponse["connectionStatus"];
    readonly reconnectReason?: ConnectorResponse["reconnectReason"];
    readonly oauthScopes?: readonly string[];
    readonly tokenExpiresAt?: string | null;
  }[],
): ConnectorResponse[] {
  const responses = connectors.map((connector) => {
    return {
      id: crypto.randomUUID(),
      slug: connector.connectorSlug,
      authMethod: connector.authMethod ?? "oauth",
      externalId: null,
      externalUsername: connector.externalUsername ?? null,
      externalEmail: null,
      oauthScopes: connector.oauthScopes ? [...connector.oauthScopes] : null,
      connectionStatus: connector.connectionStatus ?? "connected",
      reconnectReason: connector.reconnectReason ?? null,
      tokenExpiresAt: connector.tokenExpiresAt ?? null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } satisfies ConnectorResponse;
  });
  context.mocks.data.connectors(responses);
  return responses;
}

export function publicStatusItem(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly icon?: PublicConnectorCatalogStatusItem["icon"];
  readonly authMethods?: PublicConnectorCatalogStatusItem["authMethods"];
  readonly singleAuthCodeAuthMethodId?: string | null;
  readonly connectNotice?: PublicConnectorCatalogStatusItem["connectNotice"];
  readonly connection?: PublicConnectorCatalogStatusItem["connection"];
  readonly connected?: boolean;
  readonly connectionStatus?: PublicConnectorCatalogStatusItem["connectionStatus"];
  readonly scopeMismatch?: boolean;
  readonly authMethodSupportsRefresh?: boolean;
  readonly tokenExpiresAt?: string | null;
  readonly permissionSummary?: PublicConnectorCatalogStatusItem["permissionSummary"];
  readonly popularityRank?: number;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.connectorSlug,
    label: args.label,
    ...(args.popularityRank === undefined
      ? {}
      : { popularityRank: args.popularityRank }),
    description: args.description ?? `${args.label} public description`,
    icon: args.icon ?? {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: args.category ?? "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: args.authMethods ?? [],
    permissionSummary: args.permissionSummary ?? {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: args.connection ?? null,
    connected: args.connected ?? false,
    connectionStatus: args.connectionStatus ?? "not-connected",
    scopeMismatch: args.scopeMismatch ?? false,
    authMethodSupportsRefresh: args.authMethodSupportsRefresh ?? false,
    tokenExpiresAt: args.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId ?? null,
    connectNotice: args.connectNotice ?? null,
  };
}

/** What the API returns per category when no category is asked for by name. */
const DISCOVERY_PER_CATEGORY = 12;

/**
 * Discovery keeps every connected connector and slices the rest per category,
 * so a fixture of connected connectors is returned whole.
 */
function browseSlice<
  T extends { readonly category: string; readonly connection: unknown },
>(connectors: readonly T[]): T[] {
  const shownPerCategory = new Map<string, number>();
  return connectors.filter((connector) => {
    if (connector.connection) {
      return true;
    }
    const shown = shownPerCategory.get(connector.category) ?? 0;
    shownPerCategory.set(connector.category, shown + 1);
    return shown < DISCOVERY_PER_CATEGORY;
  });
}

export function mockPublicConnectorStatus(
  context: TestContext,
  connectors: readonly PublicConnectorCatalogStatusItem[],
  categoryMetadata?: PublicConnectorCatalogCategoryMetadata,
  categoryConnectorCounts?: Readonly<Record<string, number>>,
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [...connectors],
      ...(categoryMetadata ? { categoryMetadata } : {}),
    });
  });
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      // Production answers a named category with the whole category, and a
      // keyword-free browse with every connected connector plus a slice of
      // each category. The fixture does the same, or the category view is
      // tested against a response the API never returns.
      const scoped = query.category
        ? connectors.filter((connector) => {
            return connector.category === query.category;
          })
        : browseSlice(connectors);
      return respond(200, {
        connectors: [...scoped],
        totalConnectorCount: connectors.length,
        ...(categoryMetadata ? { categoryMetadata } : {}),
        ...(categoryConnectorCounts ? { categoryConnectorCounts } : {}),
      });
    },
  );
}

export function customConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return customConnectorHttpResponseSchema.parse({
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    slug: "acme-search",
    displayName: "Acme Search",
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      { key: "secret", label: "Secret", kind: "secret", required: true },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
    authMode: "manual",
    storageVersion: 1,
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  });
}

export function mcpCustomConnector(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return customConnectorMcpResponseSchema.parse({
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.acme.test/server",
    transport: "streamable-http",
    prefixTemplates: [],
    fields: [
      { key: "secret", label: "Secret", kind: "secret", required: true },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
    authMode: "manual",
    permissionBundleRef: null,
    storageVersion: 1,
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  });
}

function publicOAuthConfig(
  config: NonNullable<CreateCustomConnectorBody["oauthConfig"]>,
): Omit<NonNullable<CreateCustomConnectorBody["oauthConfig"]>, "clientSecret"> {
  const { clientSecret: _clientSecret, ...publicConfig } = config;
  return publicConfig;
}

export function mockCustomConnectorStory(
  context: TestContext,
  initial: readonly {
    readonly connector: CustomConnectorHttpResponse;
    readonly account?: ConnectorAccountConnection;
  }[] = [],
): void {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  let connectors = initial.map(({ connector }) => {
    return connector;
  });
  const accounts = new Map<string, ConnectorAccountConnection>(
    initial.flatMap(({ connector, account }) => {
      return account ? [[connector.id, account] as const] : [];
    }),
  );
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [...accounts.values()].map((account) => {
        return {
          target: account.target,
          accountCount: 1,
          attentionCount: 0,
          defaultConnection: account,
        };
      }),
    });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = [...accounts.values()].find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
    },
  );
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    if (body.kind === "mcp" || body.authMode === "automatic") {
      throw new Error("Expected an HTTP custom connector");
    }
    const created = customConnector({
      displayName: body.displayName,
      prefixTemplates: body.prefixTemplates ?? [],
      fields: body.fields ?? [],
      headerInjections: body.headerInjections ?? [],
      queryInjections: body.queryInjections ?? [],
      authMode: body.authMode ?? "manual",
    });
    connectors = [...connectors, created];
    return respond(201, created);
  });
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      let updated: CustomConnectorHttpResponse | undefined;
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        updated = customConnectorHttpResponseSchema.parse({
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: body.values.map((value) => {
            return value.key;
          }),
        });
        return updated;
      });
      if (!updated) {
        throw new Error(`Expected custom connector ${params.id}`);
      }
      const connectionId = crypto.randomUUID();
      accounts.set(params.id, {
        id: connectionId,
        target: { kind: "custom", customConnectorId: params.id },
        authMethod: "manual",
        displayName: null,
        isDefault: true,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const connected = customConnectorHttpResponseSchema.parse({
        ...updated,
        connectedAccountId: connectionId,
      });
      connectors = connectors.map((connector) => {
        return connector.id === params.id ? connected : connector;
      });
      return respond(200, connected);
    },
  );
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      if (body.kind === "mcp") {
        throw new Error("Expected HTTP connector update");
      }
      let updated: CustomConnectorHttpResponse | undefined;
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        const authMode = body.authMode ?? connector.authMode;
        const oauthConfig = body.oauthConfig
          ? publicOAuthConfig(body.oauthConfig)
          : connector.oauthConfig;
        const next = customConnectorHttpResponseSchema.parse({
          ...connector,
          displayName: body.displayName,
          prefixTemplates: body.prefixTemplates,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          authMode,
          storageVersion: body.storageVersion ?? connector.storageVersion,
          ...(authMode === "oauth"
            ? { oauthConfig }
            : { oauthConfig: undefined }),
        });
        updated = next;
        return next;
      });
      if (!updated) {
        throw new Error(`Expected custom connector ${params.id}`);
      }
      return respond(200, updated);
    },
  );
  context.mocks.api(
    customConnectorByIdContract.delete,
    ({ params, respond }) => {
      accounts.delete(params.id);
      connectors = connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
  );
}

export function mockGithubAccounts(
  context: TestContext,
  accountCount: number,
): ConnectorAccountConnection[] {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  const accounts = Array.from({ length: accountCount }, (_, index) => {
    const isDefault = index === 0;
    return {
      id: isDefault
        ? "00000000-0000-4000-a000-000000000001"
        : crypto.randomUUID(),
      target: { kind: "builtin" as const, connectorSlug: "github" as const },
      authMethod: "oauth",
      displayName: isDefault ? null : `Work ${index}`,
      isDefault,
      externalId: null,
      externalUsername: isDefault ? null : `octocat-${index}`,
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: isDefault
        ? ("reconnect-required" as const)
        : ("connected" as const),
      reconnectReason: isDefault
        ? ("authorization_expired_or_revoked" as const)
        : null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
  }).reverse();
  const defaultAccount = accounts.find((account) => {
    return account.isDefault;
  });
  if (!defaultAccount) {
    throw new Error("Expected default account fixture");
  }
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: { kind: "builtin", connectorSlug: "github" },
          accountCount: accounts.length,
          attentionCount: 1,
          defaultConnection: defaultAccount,
        },
      ],
    });
  });
  return accounts;
}
