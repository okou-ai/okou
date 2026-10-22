import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  catalogFixture,
  connectorFixtureAccount,
  httpConnectorFixture,
  mcpConnectorFixture,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorAccountsContract,
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountSelection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogPermissionDetail,
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorValueInput,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  customConnectorsContract,
  customConnectorValuesContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  chatThreadConnectorSelectionContract,
  type ChatThreadServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import {
  MESSAGE_EXPERIENCE_AGENT_ID,
  createMessageExperienceHelpers,
} from "./chat-message-experience-test-helpers.ts";

export const SCOUT_AGENT_ID = MESSAGE_EXPERIENCE_AGENT_ID;
export const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000061";
export const SCOUT_THREAD_ID = "b0000000-0000-4000-a000-000000000061";
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
  readonly customConnectors?: readonly CustomConnectorResponse[];
  readonly builtinAuthorizations?: Readonly<
    Record<string, readonly ConnectorSlug[]>
  >;
  readonly customAuthorizations?: Readonly<
    Record<string, readonly AgentCustomConnectorGrant[]>
  >;
  readonly authorizationGates?: Readonly<Record<string, Promise<void>>>;
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
    readonly account: ConnectorAccountMutationIntent;
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
    readonly initialRemoteAccessOverrides?: readonly {
      protocol: "ssh" | "vnc";
      connectionId: string;
      enabled: boolean;
    }[];
  }[];
  readonly lifecycle: ReturnType<
    ReturnType<
      typeof createMessageExperienceHelpers
    >["installMessageExperienceChat"]
  >;
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
  return catalogFixture({
    ...item,
    account: {
      id: connectionId,
      authMethod,
      externalUsername: null,
      externalEmail: null,
      reconnectReason: null,
      connectionStatus: "connected",
    },
  });
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
function browseSlice<T extends { readonly category: string }>(
  connectors: readonly T[],
): T[] {
  const shownPerCategory = new Map<string, number>();
  return connectors.filter((connector) => {
    if (connectorFixtureAccount(connector)) {
      return true;
    }
    const shown = shownPerCategory.get(connector.category) ?? 0;
    shownPerCategory.set(connector.category, shown + 1);
    return shown < DISCOVERY_PER_CATEGORY;
  });
}

function savedConnectorAccounts(
  catalog: readonly PublicConnectorCatalogStatusItem[],
  customConnectors: readonly CustomConnectorResponse[],
): ConnectorAccountConnection[] {
  const byTarget = new Map<string, ConnectorAccountConnection[]>();
  for (const connector of [...catalog, ...customConnectors]) {
    const account = connectorFixtureAccount(connector);
    if (account && !byTarget.has(connectorAccountTargetKey(account.target))) {
      byTarget.set(connectorAccountTargetKey(account.target), [account]);
    }
  }
  return [...byTarget.values()].flat();
}

export function oauthAuthMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "oauth",
    label: "OAuth",
    description: "Sign in with the provider.",
    grantKind: "auth-code",
    supportsRefresh: true,
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
    supportsRefresh: false,
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
    supportsRefresh: false,
    manualFields: [],
    startOptions: [],
  };
}

export function builtinConnector(args: {
  readonly slug: ConnectorSlug;
  readonly label: string;
  readonly hasAccount?: boolean;
  readonly authMethods?: readonly PublicConnectorCatalogAuthMethodDetail[];
  readonly hasPermissions?: boolean;
  readonly tags?: readonly string[];
  readonly category?: string;
  readonly popularityRank?: number;
  readonly mcp?: PublicConnectorCatalogStatusItem["mcp"];
}): PublicConnectorCatalogStatusItem {
  const authMethods = [...(args.authMethods ?? [oauthAuthMethod()])];
  const hasAccount = args.hasAccount ?? true;
  const connectionId = `f0000000-0000-4000-a000-${args.slug
    .split("")
    .reduce((total, character) => {
      return total + character.codePointAt(0)!;
    }, 0)
    .toString()
    .padStart(12, "0")
    .slice(-12)}`;
  const authMethod = authMethods[0]?.id ?? "oauth";
  return catalogFixture({
    slug: args.slug,
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
    ...(args.mcp === undefined ? {} : { mcp: args.mcp }),
    generation: [],
    tags: [...(args.tags ?? [])],
    authMethods,
    permissionSummary: {
      hasPermissions: args.hasPermissions ?? false,
      permissionCount: args.hasPermissions ? 1 : 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId:
      authMethods.length === 1 && authMethods[0]?.grantKind === "auth-code"
        ? authMethod
        : null,
    connectNotice: null,
    account: hasAccount ? { id: connectionId, authMethod } : undefined,
  });
}

interface HttpConnectorOptions {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly hasAccount: boolean;
  readonly authMode?: "manual" | "oauth";
  readonly permissionBundleRef?: `builtin:${string}@1` | null;
  readonly providerAdapter?: "standard" | "feishu";
}

export function httpConnector(
  args: HttpConnectorOptions,
): CustomConnectorHttpResponse {
  const authMode = args.authMode ?? "manual";
  return httpConnectorFixture({
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
    ...(args.providerAdapter === "feishu"
      ? {
          connected: args.hasAccount,
          ...(args.hasAccount
            ? {
                connectedAccountId: `f${args.id.slice(1)}`,
                connectedAccountUpdatedAt: CREATED_AT,
              }
            : {}),
          missingRequiredFields: [],
          configuredFieldKeys: [],
        }
      : {}),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    account: args.hasAccount
      ? {
          id: `f${args.id.slice(1)}`,
          updatedAt: CREATED_AT,
          configuredFieldKeys: authMode === "manual" ? ["secret"] : [],
        }
      : undefined,
  });
}

export function mcpConnector(args: {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly hasAccount: boolean;
}): CustomConnectorMcpResponse {
  return mcpConnectorFixture({
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    account: args.hasAccount
      ? { id: `f${args.id.slice(1)}`, updatedAt: CREATED_AT }
      : undefined,
  });
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
    ...(args.target.kind === "builtin" ? { scopeMismatch: false } : {}),
    connectionStatus: "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function createComposerConnectorHelpers(context: TestContext) {
  const { installMessageExperienceChat } =
    createMessageExperienceHelpers(context);
  function installComposerConnectorFixture(
    options: ConnectorFixtureOptions = {},
  ): ComposerConnectorFixture {
    const fixtureThreadId = options.threadId ?? SCOUT_THREAD_ID;
    let catalog = [...(options.catalog ?? [])];
    const customConnectors = [...(options.customConnectors ?? [])];
    const builtinAuthorizations = copyAuthorizationRecord(
      options.builtinAuthorizations,
    );
    const customAuthorizations = copyAuthorizationRecord(
      options.customAuthorizations,
    );
    const threadSelections = copyAuthorizationRecord(options.threadSelections);
    const accounts = [
      ...(options.accounts ??
        savedConnectorAccounts(catalog, customConnectors)),
    ];
    const completeAccount = (
      target: ConnectorAccountTarget,
      id: string,
      authMethod: ConnectorAuthMethodId,
      configuredFieldKeys: readonly string[] = [],
    ) => {
      const index = accounts.findIndex((account) => {
        return account.id === id;
      });
      const previous = accounts[index];
      const account = {
        ...connectorAccount({
          id,
          target,
          displayName: "",
          isDefault: !accounts.some((candidate) => {
            return targetMatches(candidate.target, target);
          }),
        }),
        ...previous,
        displayName: previous?.displayName ?? null,
        authMethod,
        connectionStatus: "connected",
        reconnectReason: null,
        missingRequiredFields: [],
        configuredFieldKeys: [
          ...new Set([
            ...(previous?.configuredFieldKeys ?? []),
            ...configuredFieldKeys,
          ]),
        ],
      } satisfies ConnectorAccountConnection;
      if (index === -1) {
        accounts.push(account);
      } else {
        accounts[index] = account;
      }
      return account;
    };
    const builtinAuthorizationUpdates: BuiltinAuthorizationUpdate[] = [];
    const customAuthorizationUpdates: CustomAuthorizationUpdate[] = [];
    const customValueRequests: {
      connectorId: string;
      account: ConnectorAccountMutationIntent;
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
      initialRemoteAccessOverrides?: readonly {
        protocol: "ssh" | "vnc";
        connectionId: string;
        enabled: boolean;
      }[];
    }[] = [];
    const lifecycle = installMessageExperienceChat({
      threadId: fixtureThreadId,
      onThreadCreate: ({
        clientThreadId,
        connectorSelections,
        initialRemoteAccessOverrides,
      }) => {
        createdThreadRequests.push({
          threadId: clientThreadId,
          connectorSelections: [...(connectorSelections ?? [])],
          ...(initialRemoteAccessOverrides === undefined
            ? {}
            : { initialRemoteAccessOverrides }),
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
        const featured = options.featuredConnectorSlugs
          ? catalog.filter((connector) => {
              return options.featuredConnectorSlugs?.includes(connector.slug);
            })
          : catalog;
        // Production answers a named category with the whole category, and a
        // keyword-free browse with a slice of
        // each category. The fixture does the same, or a category view is
        // tested against a response the API never returns.
        const browsed = query.category
          ? featured.filter((connector) => {
              return connector.category === query.category;
            })
          : browseSlice(featured);
        const connectors = keyword
          ? catalog.filter((connector) => {
              return [connector.slug, connector.label, ...connector.tags].some(
                (value) => {
                  return value.toLowerCase().includes(keyword);
                },
              );
            })
          : browsed;
        return respond(200, {
          connectors,
          totalConnectorCount: catalog.length,
          ...(options.categoryConnectorCounts === undefined
            ? {}
            : { categoryConnectorCounts: options.categoryConnectorCounts }),
        });
      },
    );
    context.mocks.api(
      connectorCatalogContract.permissions,
      ({ params, respond }) => {
        const permissions = options.permissionDetails?.get(
          params.connectorSlug,
        );
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
    context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
      const savedTargets = new Set(
        accounts.map((account) => {
          return connectorAccountTargetKey(account.target);
        }),
      );
      return respond(200, {
        builtinConnectors: catalog
          .filter((connector) => {
            return savedTargets.has(`builtin:${connector.slug}`);
          })
          .map((connector) => {
            return {
              slug: connector.slug,
              label: connector.label,
              icon: connector.icon,
              hasPermissions: connector.permissionSummary.hasPermissions,
            };
          }),
        customConnectors: customConnectors
          .filter((connector) => {
            return (
              (isIntegrationManagedCustomConnector(connector) &&
                connector.connected) ||
              savedTargets.has(`custom:${connector.id}`)
            );
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
    });
    context.mocks.api(
      agentConnectorAccessContract.agent,
      async ({ params, respond }) => {
        await options.authorizationGates?.[params.id];
        return respond(200, {
          enabledConnectorSlugs: builtinAuthorizations.get(params.id) ?? [],
          customConnectorIds: (customAuthorizations.get(params.id) ?? []).map(
            (grant) => {
              return grant.customConnectorId;
            },
          ),
        });
      },
    );
    context.mocks.api(
      userBuiltinConnectorsContract.get,
      async ({ params, respond }) => {
        await options.authorizationGates?.[params.id];
        return respond(200, {
          enabledConnectorSlugs: builtinAuthorizations.get(params.id) ?? [],
        });
      },
    );
    context.mocks.api(
      userBuiltinConnectorsContract.update,
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
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, query, respond }) => {
        const account = accounts.find((candidate) => {
          return (
            candidate.id === params.connectionId &&
            targetMatches(candidate.target, query)
          );
        });
        return account
          ? respond(200, account)
          : respond(404, {
              error: { code: "NOT_FOUND", message: "Account not found" },
            });
      },
    );
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
        return respond(200, {
          connections,
          defaultConnection:
            accounts.find((connection) => {
              return (
                targetMatches(connection.target, query) && connection.isDefault
              );
            }) ?? null,
          nextCursor: null,
        });
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
          account: body.account,
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
        const account = completeAccount(
          { kind: "custom", customConnectorId: params.id },
          body.account.intent === "reconnect"
            ? body.account.connectionId
            : crypto.randomUUID(),
          current.authMode === "none" ? "none" : "manual",
          body.values.map((value) => {
            return value.key;
          }),
        );
        return respond(200, { ...current, connectionId: account.id });
      },
    );

    const installBuiltinConnection = (
      request: BuiltinConnectionRequest,
      connectionId: string,
      configuredFieldKeys: readonly string[] = [],
    ) => {
      const account = completeAccount(
        { kind: "builtin", connectorSlug: request.connectorSlug },
        connectionId,
        request.authMethod,
        configuredFieldKeys,
      );
      catalog = catalog.map((connector) => {
        return connector.slug === request.connectorSlug && account.isDefault
          ? connectedCatalogItem(connector, connectionId, request.authMethod)
          : connector;
      });
      if (request.agentId && request.authorizeAgent) {
        const current = builtinAuthorizations.get(request.agentId) ?? [];
        builtinAuthorizations.set(request.agentId, [
          ...new Set([...current, request.connectorSlug]),
        ]);
      }
      return {
        ...connectorResponse(
          request.connectorSlug,
          connectionId,
          request.authMethod,
        ),
        connectionId,
      };
    };
    context.mocks.api(
      builtinConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        const request = {
          agentId: body.agentId,
          authorizeAgent: body.authorizeAgent,
          authMethod: body.authMethod,
          connectorSlug: params.connectorSlug,
        };
        manualConnectionRequests.push(request);
        return respond(200, {
          connectionId: installBuiltinConnection(
            request,
            body.account.intent === "reconnect"
              ? body.account.connectionId
              : crypto.randomUUID(),
            Object.keys(body.values),
          ).id,
        });
      },
    );
    context.mocks.api(
      builtinConnectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        const request = {
          agentId: body.agentId,
          authorizeAgent: body.authorizeAgent,
          authMethod: body.authMethod,
          connectorSlug: params.connectorSlug,
        };
        noAuthConnectionRequests.push(request);
        return respond(200, {
          connectionId: installBuiltinConnection(
            request,
            body.account.intent === "reconnect"
              ? body.account.connectionId
              : crypto.randomUUID(),
          ).id,
        });
      },
    );
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
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
          ...(body.account.intent === "reconnect"
            ? { connectionId: body.account.connectionId }
            : {}),
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
        const request = oauthConnectionRequests.at(-1);
        if (!request) {
          throw new Error("No pending connector OAuth authorization");
        }
        installBuiltinConnection(request, connectionId);
        completedAttempts.set(oauthAttemptId, connectionId);
      },
      threadSelectionUpdates,
      clearedThreadSelections,
      createdThreadRequests,
      lifecycle,
    };
  }

  return { installComposerConnectorFixture };
}
