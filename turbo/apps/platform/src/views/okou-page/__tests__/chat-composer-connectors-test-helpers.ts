import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorAccountsContract,
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
  type ConnectorAccountSelection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogCategoryMetadata,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorsContract,
  customConnectorHttpResponseSchema,
  customConnectorValuesContract,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  chatThreadConnectorSelectionContract,
  type ChatThreadServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import {
  context,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

export const SCOUT_AGENT_ID = MESSAGE_EXPERIENCE_AGENT_ID;
export const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000061";
export const SCOUT_THREAD_ID = "b0000000-0000-4000-a000-000000000061";
export const SECOND_SCOUT_THREAD_ID = "b0000000-0000-4000-a000-000000000063";
export const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000062";
export const ACME_CONNECTOR_ID = "e0000000-0000-4000-a000-000000000061";
export const DEEPWIKI_CONNECTOR_ID = "e0000000-0000-4000-a000-000000000062";
export const FEISHU_CONNECTOR_ID = "e0000000-0000-4000-a000-000000000063";
export const ORDINARY_CONNECTOR_ID = "e0000000-0000-4000-a000-000000000064";

const CREATED_AT = "2026-08-24T10:00:00.000Z";

interface ComposerThreadFixture {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly selectedModel?: string | null;
  readonly serviceTier?: ChatThreadServiceTier | null;
}

interface ConnectorFixtureOptions {
  readonly catalog?: readonly PublicConnectorCatalogStatusItem[];
  readonly featuredConnectorSlugs?: readonly ConnectorSlug[];
  /** Category totals discovery reports, so a shelf can close on a real count. */
  readonly categoryConnectorCounts?: Readonly<Record<string, number>>;
  /** The catalog's own category names, as discovery returns them. */
  readonly categoryMetadata?: PublicConnectorCatalogCategoryMetadata;
  readonly customConnectors?: readonly CustomConnectorResponse[];
  readonly builtinAuthorizations?: Readonly<
    Record<string, readonly ConnectorSlug[]>
  >;
  readonly customAuthorizations?: Readonly<
    Record<string, readonly AgentCustomConnectorGrant[]>
  >;
  readonly authorizationGates?: Readonly<Record<string, Promise<void>>>;
  readonly accountSummaries?: readonly ConnectorAccountSummary[];
  readonly accounts?: readonly ConnectorAccountConnection[];
  readonly threadSelections?: Readonly<
    Record<string, readonly ConnectorAccountSelection[]>
  >;
  readonly permissionDetails?: ReadonlyMap<
    ConnectorSlug,
    PublicConnectorCatalogPermissionDetail
  >;
  readonly threads?: readonly ComposerThreadFixture[];
  readonly threadId?: string;
}

interface BuiltinAuthorizationUpdate {
  readonly agentId: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly operation: "replace" | "add" | "remove" | undefined;
}

interface CustomAuthorizationUpdate {
  readonly agentId: string;
  readonly grants: readonly AgentCustomConnectorGrant[];
  readonly operation: "replace" | "add" | "remove" | undefined;
}

interface BuiltinConnectionRequest {
  readonly agentId: string | undefined;
  readonly authorizeAgent: true | undefined;
  readonly authMethod: ConnectorAuthMethodId;
  readonly connectorSlug: ConnectorSlug;
}

interface OAuthConnectionRequest extends BuiltinConnectionRequest {
  readonly callbackTarget: "app" | undefined;
}

interface ThreadSelectionUpdate {
  readonly threadId: string;
  readonly selection: ConnectorAccountSelection;
}

interface ComposerConnectorFixture {
  readonly builtinAuthorizationUpdates: readonly BuiltinAuthorizationUpdate[];
  readonly customAuthorizationUpdates: readonly CustomAuthorizationUpdate[];
  readonly customValueRequests: readonly {
    readonly connectorId: string;
    readonly values: readonly CustomConnectorValueInput[];
  }[];
  readonly manualConnectionRequests: readonly BuiltinConnectionRequest[];
  readonly noAuthConnectionRequests: readonly BuiltinConnectionRequest[];
  readonly oauthConnectionRequests: readonly OAuthConnectionRequest[];
  readonly completeOAuth: (connectionId: string) => void;
  readonly threadSelectionUpdates: readonly ThreadSelectionUpdate[];
  readonly clearedThreadSelections: readonly {
    readonly threadId: string;
    readonly target: ConnectorAccountTarget;
  }[];
  readonly createdThreadRequests: readonly {
    readonly threadId: string | undefined;
    readonly connectorSelections: readonly ConnectorAccountSelection[];
  }[];
  readonly lifecycle: ReturnType<typeof installMessageExperienceChat>;
}

function copyAuthorizationRecord<T>(
  source: Readonly<Record<string, readonly T[]>> | undefined,
): Map<string, T[]> {
  return new Map(
    Object.entries(source ?? {}).map(([key, values]) => {
      return [key, [...values]];
    }),
  );
}

function updateList<T>(
  current: readonly T[],
  requested: readonly T[],
  operation: "replace" | "add" | "remove" | undefined,
  key: (value: T) => string,
): T[] {
  if (operation === "add") {
    const values = new Map(
      current.map((value) => {
        return [key(value), value] as const;
      }),
    );
    for (const value of requested) {
      values.set(key(value), value);
    }
    return [...values.values()];
  }
  if (operation === "remove") {
    const removed = new Set(requested.map(key));
    return current.filter((value) => {
      return !removed.has(key(value));
    });
  }
  return [...requested];
}

function targetMatches(
  left: ConnectorAccountTarget,
  right: ConnectorAccountTarget,
): boolean {
  return connectorAccountTargetKey(left) === connectorAccountTargetKey(right);
}

function connectedCatalogItem(
  item: PublicConnectorCatalogStatusItem,
  connectionId: string,
  authMethod: ConnectorAuthMethodId,
): PublicConnectorCatalogStatusItem {
  return {
    ...item,
    connected: true,
    connectionStatus: "connected",
    connection: {
      id: connectionId,
      authMethod,
      externalUsername: null,
      externalEmail: null,
      reconnectReason: null,
    },
  };
}

function connectorResponse(
  connectorSlug: ConnectorSlug,
  connectionId: string,
  authMethod: ConnectorAuthMethodId,
) {
  return {
    id: connectionId,
    slug: connectorSlug,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected" as const,
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
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

export function installComposerConnectorFixture(
  options: ConnectorFixtureOptions = {},
): ComposerConnectorFixture {
  const fixtureThreadId = options.threadId ?? SCOUT_THREAD_ID;
  let catalog = [...(options.catalog ?? [])];
  let customConnectors = [...(options.customConnectors ?? [])];
  const builtinAuthorizations = copyAuthorizationRecord(
    options.builtinAuthorizations,
  );
  const customAuthorizations = copyAuthorizationRecord(
    options.customAuthorizations,
  );
  const threadSelections = copyAuthorizationRecord(options.threadSelections);
  const accounts = [...(options.accounts ?? [])];
  const builtinAuthorizationUpdates: BuiltinAuthorizationUpdate[] = [];
  const customAuthorizationUpdates: CustomAuthorizationUpdate[] = [];
  const customValueRequests: {
    connectorId: string;
    values: readonly CustomConnectorValueInput[];
  }[] = [];
  const manualConnectionRequests: BuiltinConnectionRequest[] = [];
  const noAuthConnectionRequests: BuiltinConnectionRequest[] = [];
  const oauthConnectionRequests: OAuthConnectionRequest[] = [];
  const completedAttempts = mockOAuthCompletions(context);
  let oauthAttemptId = crypto.randomUUID();
  const threadSelectionUpdates: ThreadSelectionUpdate[] = [];
  const clearedThreadSelections: {
    threadId: string;
    target: ConnectorAccountTarget;
  }[] = [];
  const createdThreadRequests: {
    threadId: string | undefined;
    connectorSelections: ConnectorAccountSelection[];
  }[] = [];
  const lifecycle = installMessageExperienceChat({
    threadId: fixtureThreadId,
    onThreadCreate: ({ clientThreadId, connectorSelections }) => {
      createdThreadRequests.push({
        threadId: clientThreadId,
        connectorSelections: [...(connectorSelections ?? [])],
      });
    },
  });
  context.mocks.data.agents([
    { agentId: SCOUT_AGENT_ID, displayName: "Scout" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  const threads =
    options.threads ??
    (options.threadId
      ? [
          {
            id: fixtureThreadId,
            title: "Scout chat",
            agentId: SCOUT_AGENT_ID,
          },
        ]
      : undefined);
  if (threads) {
    lifecycle.setThreadList(
      threads.map((thread, index) => {
        return {
          id: thread.id,
          title: thread.title,
          agent: { id: thread.agentId, avatarUrl: null },
          createdAt: CREATED_AT,
          updatedAt: new Date(
            Date.parse(CREATED_AT) + (threads.length - index) * 1000,
          ).toISOString(),
          selectedModel: thread.selectedModel ?? null,
          serviceTier: thread.serviceTier ?? null,
        };
      }),
    );
  }

  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      const keyword = query.keyword?.trim().toLowerCase();
      const scopedCatalog = catalog.filter((connector) => {
        return (
          query.protocol === "all" ||
          (connector.protocol ?? "http") === (query.protocol ?? "http")
        );
      });
      const featured = options.featuredConnectorSlugs
        ? scopedCatalog.filter((connector) => {
            return options.featuredConnectorSlugs?.includes(connector.slug);
          })
        : scopedCatalog;
      // Production answers a named category with the whole category, and a
      // keyword-free browse with every connected connector plus a slice of
      // each category. The fixture does the same, or a category view is
      // tested against a response the API never returns.
      const browsed = query.category
        ? featured.filter((connector) => {
            return connector.category === query.category;
          })
        : browseSlice(featured);
      const connectors = keyword
        ? scopedCatalog.filter((connector) => {
            return [connector.slug, connector.label, ...connector.tags].some(
              (value) => {
                return value.toLowerCase().includes(keyword);
              },
            );
          })
        : browsed;
      return respond(200, {
        connectors,
        totalConnectorCount: scopedCatalog.length,
        ...(options.categoryConnectorCounts === undefined
          ? {}
          : { categoryConnectorCounts: options.categoryConnectorCounts }),
        ...(options.categoryMetadata === undefined
          ? {}
          : { categoryMetadata: options.categoryMetadata }),
      });
    },
  );
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      const permissions = options.permissionDetails?.get(params.connectorSlug);
      return permissions
        ? respond(200, { permissions })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Permissions not found" },
          });
    },
  );
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: customConnectors });
  });
  context.mocks.api(userConnectorsContract.get, async ({ params, respond }) => {
    await options.authorizationGates?.[params.id];
    return respond(200, {
      enabledConnectorSlugs: builtinAuthorizations.get(params.id) ?? [],
    });
  });
  context.mocks.api(
    userConnectorsContract.update,
    ({ body, params, respond }) => {
      const connectorSlugs = [...body.enabledConnectorSlugs];
      builtinAuthorizationUpdates.push({
        agentId: params.id,
        connectorSlugs,
        operation: body.operation,
      });
      const next = updateList(
        builtinAuthorizations.get(params.id) ?? [],
        connectorSlugs,
        body.operation,
        (connectorSlug) => {
          return connectorSlug;
        },
      );
      builtinAuthorizations.set(params.id, next);
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.get,
    async ({ params, respond }) => {
      await options.authorizationGates?.[params.id];
      return respond(200, {
        grants: customAuthorizations.get(params.id) ?? [],
      });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      const grants = body.grants.map((grant) => {
        return { ...grant, permissionNames: [...grant.permissionNames] };
      });
      customAuthorizationUpdates.push({
        agentId: params.id,
        grants,
        operation: body.operation,
      });
      const next = updateList(
        customAuthorizations.get(params.id) ?? [],
        grants,
        body.operation,
        (grant) => {
          return grant.customConnectorId;
        },
      );
      customAuthorizations.set(params.id, next);
      return respond(200, { grants: next });
    },
  );
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, { summaries: [...(options.accountSummaries ?? [])] });
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const normalizedSearch = query.search?.toLowerCase();
      const connections = accounts.filter((connection) => {
        if (!targetMatches(connection.target, query)) {
          return false;
        }
        if (!normalizedSearch) {
          return true;
        }
        return [
          connection.displayName,
          connection.externalEmail,
          connection.externalUsername,
          connection.externalId,
        ].some((value) => {
          return value?.toLowerCase().includes(normalizedSearch);
        });
      });
      return respond(200, { connections, nextCursor: null });
    },
  );
  context.mocks.api(
    chatThreadConnectorSelectionContract.get,
    ({ params, respond }) => {
      const selections = threadSelections.get(params.id) ?? [];
      const selectedConnections = selections.flatMap((selection) => {
        const connection = accounts.find((candidate) => {
          return candidate.id === selection.connectionId;
        });
        return connection ? [connection] : [];
      });
      return respond(200, { selections, selectedConnections });
    },
  );
  context.mocks.api(
    chatThreadConnectorSelectionContract.update,
    ({ body, params, respond }) => {
      const selection = { ...body };
      threadSelectionUpdates.push({ threadId: params.id, selection });
      const current = threadSelections.get(params.id) ?? [];
      threadSelections.set(params.id, [
        ...current.filter((candidate) => {
          return !targetMatches(candidate.target, selection.target);
        }),
        selection,
      ]);
      return respond(200, selection);
    },
  );
  context.mocks.api(
    chatThreadConnectorSelectionContract.clear,
    ({ body, params, respond }) => {
      clearedThreadSelections.push({ threadId: params.id, target: body });
      const current = threadSelections.get(params.id) ?? [];
      threadSelections.set(
        params.id,
        current.filter((selection) => {
          return !targetMatches(selection.target, body);
        }),
      );
      return respond(204);
    },
  );
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ body, params, respond }) => {
      customValueRequests.push({
        connectorId: params.id,
        values: body.values.map((value) => {
          return { ...value };
        }),
      });
      const current = customConnectors.find((connector) => {
        return connector.id === params.id;
      });
      if (!current) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      const connected = {
        ...current,
        connected: true,
        connectedAccountId:
          current.connectedAccountId ?? "f0000000-0000-4000-a000-000000000061",
        connectedAccountUpdatedAt: CREATED_AT,
        configuredFieldKeys: body.values.map((value) => {
          return value.key;
        }),
        missingRequiredFields: [],
        updatedAt: CREATED_AT,
      };
      customConnectors = customConnectors.map((connector) => {
        return connector.id === connected.id ? connected : connector;
      });
      return respond(200, connected);
    },
  );

  const installBuiltinConnection = (
    request: BuiltinConnectionRequest,
    connectionId: string,
  ) => {
    catalog = catalog.map((connector) => {
      return connector.slug === request.connectorSlug
        ? connectedCatalogItem(connector, connectionId, request.authMethod)
        : connector;
    });
    if (request.agentId && request.authorizeAgent) {
      const current = builtinAuthorizations.get(request.agentId) ?? [];
      builtinAuthorizations.set(request.agentId, [
        ...new Set([...current, request.connectorSlug]),
      ]);
    }
    return connectorResponse(
      request.connectorSlug,
      connectionId,
      request.authMethod,
    );
  };
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      const request = {
        agentId: body.agentId,
        authorizeAgent: body.authorizeAgent,
        authMethod: body.authMethod,
        connectorSlug: params.connectorSlug,
      };
      manualConnectionRequests.push(request);
      return respond(
        200,
        installBuiltinConnection(
          request,
          "f0000000-0000-4000-a000-000000000062",
        ),
      );
    },
  );
  context.mocks.api(
    connectorNoAuthGrantContract.connect,
    ({ body, params, respond }) => {
      const request = {
        agentId: body.agentId,
        authorizeAgent: body.authorizeAgent,
        authMethod: body.authMethod,
        connectorSlug: params.connectorSlug,
      };
      noAuthConnectionRequests.push(request);
      return respond(
        200,
        installBuiltinConnection(
          request,
          "f0000000-0000-4000-a000-000000000063",
        ),
      );
    },
  );
  context.mocks.api(
    connectorOauthStartContract.start,
    ({ body, params, respond }) => {
      oauthAttemptId = crypto.randomUUID();
      oauthConnectionRequests.push({
        agentId: body.agentId,
        authorizeAgent: body.authorizeAgent,
        authMethod: body.authMethod,
        callbackTarget: body.callbackTarget,
        connectorSlug: params.connectorSlug,
      });
      return respond(200, {
        authorizationUrl: `https://accounts.example.test/${params.connectorSlug}`,
        oauthAttemptId,
        connectionId: "f0000000-0000-4000-a000-000000000064",
      });
    },
  );

  return {
    builtinAuthorizationUpdates,
    customAuthorizationUpdates,
    customValueRequests,
    manualConnectionRequests,
    noAuthConnectionRequests,
    oauthConnectionRequests,
    completeOAuth: (connectionId: string) => {
      completedAttempts.set(oauthAttemptId, connectionId);
    },
    threadSelectionUpdates,
    clearedThreadSelections,
    createdThreadRequests,
    lifecycle,
  };
}

export function oauthAuthMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "oauth",
    label: "OAuth",
    description: "Sign in with the provider.",
    grantKind: "auth-code",
    manualFields: [],
    startOptions: [],
  };
}

export function manualAuthMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "api-token",
    label: "API Token",
    description: "Enter the API token.",
    grantKind: "manual",
    manualFields: [
      {
        id: "apiToken",
        label: "API Token",
        required: true,
        placeholder: null,
        inputType: "password",
      },
    ],
    startOptions: [],
  };
}

export function noAuthMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "public",
    label: "Public access",
    description: "No credentials are required.",
    grantKind: "none",
    manualFields: [],
    startOptions: [],
  };
}

export function builtinConnector(args: {
  readonly protocol?: "mcp";
  readonly slug: ConnectorSlug;
  readonly label: string;
  readonly connected?: boolean;
  readonly authMethods?: readonly PublicConnectorCatalogAuthMethodDetail[];
  readonly hasPermissions?: boolean;
  readonly tags?: readonly string[];
  readonly category?: string;
  readonly popularityRank?: number;
}): PublicConnectorCatalogStatusItem {
  const authMethods = [...(args.authMethods ?? [oauthAuthMethod()])];
  const connected = args.connected ?? true;
  const connectionId = `f0000000-0000-4000-a000-${args.slug
    .split("")
    .reduce((total, character) => {
      return total + character.codePointAt(0)!;
    }, 0)
    .toString()
    .padStart(12, "0")
    .slice(-12)}`;
  const authMethod = authMethods[0]?.id ?? "oauth";
  return {
    slug: args.slug,
    ...(args.protocol === undefined ? {} : { protocol: args.protocol }),
    label: args.label,
    description: `${args.label} connector`,
    icon: {
      url: `https://icons.example.test/${args.slug}.svg`,
      invertInDarkMode: false,
    },
    category: args.category ?? "productivity",
    ...(args.popularityRank === undefined
      ? {}
      : { popularityRank: args.popularityRank }),
    generation: [],
    tags: [...(args.tags ?? [])],
    authMethods,
    permissionSummary: {
      hasPermissions: args.hasPermissions ?? false,
      permissionCount: args.hasPermissions ? 1 : 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: connected
      ? {
          id: connectionId,
          authMethod,
          externalUsername: null,
          externalEmail: null,
          reconnectReason: null,
        }
      : null,
    connected,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: authMethod === "oauth",
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId:
      authMethods.length === 1 && authMethods[0]?.grantKind === "auth-code"
        ? authMethod
        : null,
    connectNotice: null,
  };
}

interface HttpConnectorOptions {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly connected: boolean;
  readonly authMode?: "manual" | "oauth";
  readonly permissionBundleRef?: `builtin:${string}@1` | null;
  readonly providerAdapter?: "standard" | "feishu";
}

export function httpConnector(
  args: HttpConnectorOptions,
): CustomConnectorHttpResponse {
  const authMode = args.authMode ?? "manual";
  return customConnectorHttpResponseSchema.parse({
    id: args.id,
    slug: args.slug,
    displayName: args.displayName,
    kind: "http",
    prefixTemplates: ["https://api.example.test/"],
    fields:
      authMode === "manual"
        ? [
            {
              key: "secret",
              label: "Secret",
              kind: "secret",
              required: true,
            },
          ]
        : [],
    headerInjections: [],
    queryInjections: [],
    authMode,
    ...(authMode === "oauth"
      ? {
          oauthConfig: {
            providerAdapter: args.providerAdapter ?? "standard",
            clientId: "client-id",
            authorizationUrl: "https://auth.example.test/authorize",
            tokenUrl: "https://auth.example.test/token",
            tokenEndpointAuthMethod: "client_secret_post" as const,
            pkceMethod: "S256" as const,
            scopes: [],
            authorizationParams: {},
          },
        }
      : {}),
    permissionBundleRef: args.permissionBundleRef ?? null,
    skillMarkdown: null,
    storageVersion: 1,
    connected: args.connected,
    ...(args.connected
      ? {
          connectedAccountId: `f${args.id.slice(1)}`,
          connectedAccountUpdatedAt: CREATED_AT,
        }
      : {}),
    missingRequiredFields:
      args.connected || authMode === "oauth" ? [] : ["secret"],
    configuredFieldKeys:
      args.connected && authMode === "manual" ? ["secret"] : [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

export function mcpConnector(args: {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly connected: boolean;
}): CustomConnectorMcpResponse {
  return {
    id: args.id,
    slug: args.slug,
    displayName: args.displayName,
    kind: "mcp",
    endpoint: "https://mcp.example.test/connect",
    transport: "streamable-http",
    prefixTemplates: [],
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "manual",
    permissionBundleRef: null,
    skillMarkdown: null,
    storageVersion: 1,
    connected: args.connected,
    ...(args.connected
      ? {
          connectedAccountId: `f${args.id.slice(1)}`,
          connectedAccountUpdatedAt: CREATED_AT,
        }
      : {}),
    missingRequiredFields: [],
    configuredFieldKeys: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function permissionDetail(
  connectorSlug: ConnectorSlug,
  label: string,
  names: readonly string[],
): PublicConnectorCatalogPermissionDetail {
  return {
    connectorSlug,
    label,
    icon: {
      url: `https://icons.example.test/${connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: names.length,
    permissions: names.map((name) => {
      return { name, description: `${name} permission` };
    }),
    categories: null,
    defaultPolicy: {
      permissionDefault: "allow",
      unknownPolicy: "deny",
    },
  };
}

export function connectorAccount(args: {
  readonly id: string;
  readonly target: ConnectorAccountTarget;
  readonly displayName: string;
  readonly isDefault: boolean;
}): ConnectorAccountConnection {
  return {
    id: args.id,
    target: args.target,
    authMethod: "oauth",
    displayName: args.displayName,
    isDefault: args.isDefault,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function accountSummary(
  target: ConnectorAccountTarget,
  accounts: readonly ConnectorAccountConnection[],
): ConnectorAccountSummary {
  return {
    target,
    accountCount: accounts.length,
    attentionCount: 0,
    defaultConnection:
      accounts.find((account) => {
        return account.isDefault;
      }) ?? null,
  };
}
