import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  ConnectorExternalCodeSessionStartResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogConnection,
  type PublicConnectorCatalogConnectionStatus,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorExternalCodeSessionContract,
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOauthDeviceAuthSessionContract,
  connectorScopeDiffContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { mockApi } from "../msw-contract.ts";
import {
  testConnectorCatalogCategoryMetadata,
  testConnectorCatalogDefinitions,
  testConnectorPermissionDetails,
  type TestConnectorCatalogDefinition,
} from "./connector-catalog-fixtures.ts";

let mockConnectors: ConnectorResponse[] = [];
const mockConnectorAccountDisplayNames = new Map<string, string | null>();
const mockConnectorRequestedScopes = new Map<string, readonly string[]>();
type MockOauthDeviceAuthSessionStartResponse = Omit<
  Partial<ConnectorOauthDeviceAuthSessionStartResponse>,
  "verificationUriComplete"
> & {
  readonly verificationUriComplete?: string | undefined;
};

let mockOauthDeviceAuthSessionStartResponse:
  | MockOauthDeviceAuthSessionStartResponse
  | undefined;
let mockOauthDeviceAuthSessionPollResponses: ConnectorOauthDeviceAuthSessionPollResponse[] =
  [];

let mockExternalCodeSessionStartResponse:
  | Partial<ConnectorExternalCodeSessionStartResponse>
  | undefined;

function createMockOauthDeviceAuthConnector(
  connectorSlug: ConnectorSlug,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00Z";
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod: "oauth",
    externalId: `mock-${connectorSlug}-external-id`,
    externalUsername: `mock-${connectorSlug}`,
    externalEmail: null,
    oauthScopes: ["read"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultOauthDeviceAuthSessionStartResponse(
  connectorSlug: ConnectorSlug,
): ConnectorOauthDeviceAuthSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    sessionToken: `mock-${connectorSlug}-oauth-device-session-token`,
    connectorSlug,
    status: "pending",
    userCode: "OKOU-DEVICE",
    verificationUri: `https://oauth.test/${connectorSlug}/device`,
    verificationUriComplete: `https://oauth.test/${connectorSlug}/device?user_code=OKOU-DEVICE`,
    expiresIn: 300,
    interval: 1,
  };
}

function createMockLocalGrantConnector(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createMockExternalCodeConnector(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod,
    externalId: `mock-${connectorSlug}-account`,
    externalUsername: `arn:aws:iam::000000000000:user/mock-${connectorSlug}`,
    externalEmail: null,
    oauthScopes: ["openid"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function defaultExternalCodeSessionStartResponse(
  connectorSlug: ConnectorSlug,
): ConnectorExternalCodeSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionToken: `mock-${connectorSlug}-external-code-session-token`,
    connectorSlug,
    status: "pending",
    authorizationUrl: `https://oauth.test/${connectorSlug}/external-code`,
    expiresIn: 600,
  };
}

export function setMockConnectors(
  connectors: ConnectorResponse[],
  requestedScopesByConnectionId?: ReadonlyMap<string, readonly string[]>,
): void {
  mockConnectors = connectors;
  mockConnectorRequestedScopes.clear();
  for (const connector of connectors) {
    storeMockConnectorRequestedScopes(
      connector,
      requestedScopesByConnectionId?.get(connector.id) ??
        connector.oauthScopes ??
        [],
    );
  }
}

export function resetMockConnectors(): void {
  mockConnectors = [];
  mockConnectorAccountDisplayNames.clear();
  mockConnectorRequestedScopes.clear();
  resetMockOauthDeviceAuth();
}

function mockAccountForConnector(
  connector: ConnectorResponse,
): ConnectorAccountConnection {
  return {
    id: connector.id,
    target: { kind: "builtin", connectorSlug: connector.slug },
    authMethod: connector.authMethod,
    displayName: mockConnectorAccountDisplayNames.get(connector.id) ?? null,
    isDefault: true,
    externalId: connector.externalId,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    oauthScopes: connector.oauthScopes,
    connectionStatus: connector.connectionStatus,
    reconnectReason: connector.reconnectReason,
    tokenExpiresAt: connector.tokenExpiresAt,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

function mockAccountMatchesTarget(
  account: ConnectorAccountConnection,
  target: ConnectorAccountTarget,
): boolean {
  if (target.kind === "builtin") {
    return (
      account.target.kind === "builtin" &&
      account.target.connectorSlug === target.connectorSlug
    );
  }
  return (
    account.target.kind === "custom" &&
    account.target.customConnectorId === target.customConnectorId
  );
}

function findMockAccount(
  connectionId: string,
  target: ConnectorAccountTarget,
): ConnectorAccountConnection | undefined {
  return mockConnectors.map(mockAccountForConnector).find((account) => {
    return (
      account.id === connectionId && mockAccountMatchesTarget(account, target)
    );
  });
}

function upsertMockConnector(connector: ConnectorResponse): void {
  for (const existing of mockConnectors) {
    if (existing.slug === connector.slug) {
      mockConnectorRequestedScopes.delete(existing.id);
    }
  }
  mockConnectors = [
    ...mockConnectors.filter((c) => {
      return c.slug !== connector.slug;
    }),
    connector,
  ];
  storeMockConnectorRequestedScopes(connector);
}

function storeMockConnectorRequestedScopes(
  connector: ConnectorResponse,
  requestedScopes?: readonly string[],
): void {
  const definition = testConnectorCatalogDefinitions.find((candidate) => {
    return candidate.connectorSlug === connector.slug;
  });
  const method = definition?.authMethods.find((candidate) => {
    return candidate.detail.id === connector.authMethod;
  });
  if (method) {
    mockConnectorRequestedScopes.set(connector.id, [
      ...(requestedScopes ?? method.requestedScopes),
    ]);
  }
}

function resetMockOauthDeviceAuth(): void {
  mockOauthDeviceAuthSessionStartResponse = undefined;
  mockOauthDeviceAuthSessionPollResponses = [];
  mockExternalCodeSessionStartResponse = undefined;
}

function mockPermissionDetail(
  connectorSlug: string,
): PublicConnectorCatalogPermissionDetail | null {
  return testConnectorPermissionDetails.get(connectorSlug) ?? null;
}

function mockConnectionForCatalogStatus(
  connector: ConnectorResponse | null,
): PublicConnectorCatalogConnection | null {
  if (!connector) {
    return null;
  }
  return {
    authMethod: connector.authMethod,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    reconnectReason: connector.reconnectReason,
  };
}

function mockSingleAuthCodeAuthMethodId(
  authMethods: readonly PublicConnectorCatalogAuthMethodDetail[],
): ConnectorAuthMethodId | null {
  const [authMethod] = authMethods;
  if (authMethods.length !== 1 || !authMethod) {
    return null;
  }
  return authMethod.grantKind === "auth-code" ? authMethod.id : null;
}

function mockConnectorAuthMethodSupportsRefresh(
  definition: TestConnectorCatalogDefinition,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return Boolean(
    definition.authMethods.find((method) => {
      return method.detail.id === authMethod;
    })?.supportsRefresh,
  );
}

function mockConnectorHasRequestedScopes(
  definition: TestConnectorCatalogDefinition,
  connector: ConnectorResponse,
): boolean {
  const method = definition.authMethods.find((candidate) => {
    return candidate.detail.id === connector.authMethod;
  });
  if (!method || method.requestedScopes.length === 0) {
    return true;
  }
  const storedScopes = mockConnectorRequestedScopes.get(connector.id);
  if (!storedScopes) {
    return false;
  }
  const storedScopeSet = new Set(storedScopes);
  return method.requestedScopes.every((scope) => {
    return storedScopeSet.has(scope);
  });
}

function mockConnectorScopeDiff(
  connector: ConnectorResponse,
): ScopeDiffResponse | null {
  const definition = testConnectorCatalogDefinitions.find((candidate) => {
    return candidate.connectorSlug === connector.slug;
  });
  const method = definition?.authMethods.find((candidate) => {
    return candidate.detail.id === connector.authMethod;
  });
  if (!method) {
    return null;
  }
  const currentScopes = [...method.requestedScopes];
  const storedScopes = [
    ...(mockConnectorRequestedScopes.get(connector.id) ?? []),
  ];
  const current = new Set(currentScopes);
  const stored = new Set(storedScopes);
  return {
    addedScopes: currentScopes.filter((scope) => {
      return !stored.has(scope);
    }),
    removedScopes: storedScopes.filter((scope) => {
      return !current.has(scope);
    }),
    currentScopes,
    storedScopes,
  };
}

function mockConnectorCatalogStatusItem(
  definition: TestConnectorCatalogDefinition,
  authMethods: readonly PublicConnectorCatalogAuthMethodDetail[],
  connector: ConnectorResponse | null,
): PublicConnectorCatalogStatusItem {
  const scopeMismatch =
    connector !== null &&
    !mockConnectorHasRequestedScopes(definition, connector);
  let connectionStatus: PublicConnectorCatalogConnectionStatus =
    "not-connected";
  if (connector !== null) {
    connectionStatus =
      connector.connectionStatus === "reconnect-required"
        ? "reconnect-required"
        : scopeMismatch
          ? "scope-mismatch"
          : "connected";
  }

  return {
    slug: definition.connectorSlug,
    label: definition.label,
    description: definition.description,
    icon: definition.icon,
    category: definition.category,
    generation: [...definition.generation],
    tags: [...definition.tags],
    authMethods: [...authMethods],
    permissionSummary: definition.permissionSummary,
    connection: mockConnectionForCatalogStatus(connector),
    connected: connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      connector !== null &&
      mockConnectorAuthMethodSupportsRefresh(definition, connector.authMethod),
    tokenExpiresAt: connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: mockSingleAuthCodeAuthMethodId(authMethods),
    connectNotice: definition.connectNotice,
  };
}

function mockConnectorCatalogStatus(): PublicConnectorCatalogStatusItem[] {
  const connectorsBySlug = new Map(
    mockConnectors.map((connector) => {
      return [connector.slug, connector];
    }),
  );
  return testConnectorCatalogDefinitions.map((definition) => {
    const authMethods = definition.authMethods.map((method) => {
      return method.detail;
    });
    return mockConnectorCatalogStatusItem(
      definition,
      authMethods,
      connectorsBySlug.get(definition.connectorSlug) ?? null,
    );
  });
}

export const apiConnectorsHandlers = [
  mockApi(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  }),
  mockApi(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  }),
  mockApi(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  }),
  mockApi(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  }),
  mockApi(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: false });
  }),
  mockApi(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  }),
  mockApi(connectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockConnectors,
      connectorProvidedBindings: [],
    });
  }),

  mockApi(connectorCatalogContract.status, ({ respond }) => {
    const connectors = mockConnectorCatalogStatus();
    return respond(200, {
      connectors,
      categoryMetadata: testConnectorCatalogCategoryMetadata,
    });
  }),

  mockApi(connectorCatalogContract.discovery, ({ query, respond }) => {
    const allConnectors = mockConnectorCatalogStatus();
    const keyword = query.keyword?.trim().toLowerCase();
    const connectors = keyword
      ? allConnectors
          .filter((connector) => {
            return (
              connector.slug.toLowerCase().includes(keyword) ||
              connector.label.toLowerCase().includes(keyword)
            );
          })
          .slice(0, 100)
      : allConnectors.slice(0, 100);
    return respond(200, {
      connectors,
      categoryMetadata: testConnectorCatalogCategoryMetadata,
      totalConnectorCount: allConnectors.length,
    });
  }),

  mockApi(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [] });
  }),

  mockApi(connectorCatalogContract.diagnostics, ({ respond }) => {
    return respond(200, {
      schemaVersion: 4,
      state: "stale",
      active: {
        catalogVersion: "2026-07-25.1",
        catalogDigest: `sha256:${"a".repeat(64)}`,
        activatedAt: "2026-07-25T01:00:00.000Z",
      },
      lastAttempt: {
        at: "2026-07-25T02:00:00.000Z",
        outcome: "rejected",
        failureCode: "invalid-artifact",
        reusedCachedRejection: true,
      },
      lastSuccessAt: "2026-07-25T02:00:00.000Z",
      rejectedCandidate: {
        catalogVersion: "2026-07-25.2",
        catalogDigest: `sha256:${"c".repeat(64)}`,
        failureCode: "invalid-artifact",
        backendVersion: "1.319.0",
      },
      filtering: {
        capabilityDigest: `sha256:${"b".repeat(64)}`,
        evaluatedAt: "2026-07-25T01:00:00.000Z",
        stale: false,
        filteredAuthMethods: [
          {
            connectorSlug: "github",
            authMethodId: "oauth",
            reasons: ["missing-revoke-provider"],
          },
        ],
      },
      credentialStorage: {
        missingConnectorVersions: 1,
        unownedConnectorSecrets: 2,
        unownedConnectorVariables: 3,
        unresolvedBridgeCredentials: 5,
      },
    });
  }),

  // Keep this parameterized route after the static /diagnostics route so the
  // mock server does not interpret "diagnostics" as a connector slug.
  mockApi(connectorCatalogContract.get, ({ params, respond }) => {
    const connector = mockConnectorCatalogStatus().find((candidate) => {
      return candidate.slug === params.connectorSlug;
    });
    if (!connector) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, { connector });
  }),

  mockApi(connectorCatalogContract.permissions, ({ params, respond }) => {
    const permissions = mockPermissionDetail(params.connectorSlug);
    if (!permissions) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, { permissions });
  }),

  mockApi(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: mockConnectors.map((connector) => {
        const account = mockAccountForConnector(connector);
        return {
          target: account.target,
          accountCount: 1,
          attentionCount:
            account.connectionStatus === "reconnect-required" ? 1 : 0,
          defaultConnection: account,
        };
      }),
    });
  }),

  mockApi(connectorAccountsContract.connections, ({ query, respond }) => {
    const allAccounts = mockConnectors.map((connector) => {
      const account = mockAccountForConnector(connector);
      const definition = testConnectorCatalogDefinitions.find((candidate) => {
        return candidate.connectorSlug === connector.slug;
      });
      return query.kind === "builtin" &&
        query.includeScopeMismatch === "true" &&
        definition
        ? {
            ...account,
            scopeMismatch: !mockConnectorHasRequestedScopes(
              definition,
              connector,
            ),
          }
        : account;
    });
    const accounts = allAccounts
      .filter((account) => {
        return mockAccountMatchesTarget(account, query);
      })
      .filter((account) => {
        const search = query.search?.toLowerCase();
        return search
          ? [
              account.displayName,
              account.externalEmail,
              account.externalUsername,
              account.externalId,
            ].some((value) => {
              return value?.toLowerCase().includes(search);
            })
          : true;
      });
    const start = query.cursor ? Number(query.cursor) : 0;
    const page = accounts.slice(start, start + query.limit);
    const next = start + page.length;
    const defaultConnection = allAccounts.find((account) => {
      return account.isDefault && mockAccountMatchesTarget(account, query);
    });
    return respond(200, {
      connections: page,
      nextCursor: next < accounts.length ? String(next) : null,
      ...(query.kind === "builtin" && query.includeScopeMismatch === "true"
        ? { defaultConnection: defaultConnection ?? null }
        : {}),
    });
  }),

  mockApi(
    connectorAccountsContract.connection,
    ({ params, query, respond }) => {
      const account = findMockAccount(params.connectionId, query);
      return account
        ? respond(200, account)
        : respond(404, {
            error: {
              message: "Connector account not found",
              code: "NOT_FOUND",
            },
          });
    },
  ),

  mockApi(connectorAccountsContract.scopeDiff, ({ params, query, respond }) => {
    const connector = mockConnectors.find((candidate) => {
      return (
        candidate.id === params.connectionId &&
        candidate.slug === query.connectorSlug
      );
    });
    const diff = connector ? mockConnectorScopeDiff(connector) : null;
    return diff
      ? respond(200, diff)
      : respond(404, {
          error: {
            message: "Connector account not found",
            code: "NOT_FOUND",
          },
        });
  }),

  mockApi(connectorAccountsContract.rename, ({ params, body, respond }) => {
    const account = findMockAccount(params.connectionId, body.target);
    if (!account) {
      return respond(404, {
        error: { message: "Connector account not found", code: "NOT_FOUND" },
      });
    }
    mockConnectorAccountDisplayNames.set(account.id, body.displayName);
    return respond(200, { ...account, displayName: body.displayName });
  }),

  mockApi(connectorAccountsContract.setDefault, ({ params, body, respond }) => {
    const account = findMockAccount(params.connectionId, body.target);
    return account
      ? respond(200, account)
      : respond(404, {
          error: { message: "Connector account not found", code: "NOT_FOUND" },
        });
  }),

  mockApi(
    connectorAccountsContract.deletionImpact,
    ({ params, query, respond }) => {
      return findMockAccount(params.connectionId, query)
        ? respond(200, {
            connectionId: params.connectionId,
            explicitSelectionCount: 0,
            hasSibling: false,
          })
        : respond(404, {
            error: {
              message: "Connector account not found",
              code: "NOT_FOUND",
            },
          });
    },
  ),

  mockApi(connectorAccountsContract.delete, ({ params, body, respond }) => {
    const account = findMockAccount(params.connectionId, body.target);
    if (!account) {
      return respond(404, {
        error: { message: "Connector account not found", code: "NOT_FOUND" },
      });
    }
    mockConnectors = mockConnectors.filter((connector) => {
      return connector.id !== params.connectionId;
    });
    mockConnectorAccountDisplayNames.delete(params.connectionId);
    mockConnectorRequestedScopes.delete(params.connectionId);
    return respond(200, {
      deletedConnectionId: params.connectionId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
  }),

  mockApi(connectorManualGrantContract.connect, ({ body, params, respond }) => {
    const connector = createMockLocalGrantConnector(
      params.connectorSlug,
      body.authMethod,
    );
    if (body.account?.intent === "add") {
      mockConnectorAccountDisplayNames.set(
        connector.id,
        body.account.displayName ?? null,
      );
    }
    upsertMockConnector(connector);
    return respond(200, connector);
  }),

  mockApi(connectorNoAuthGrantContract.connect, ({ body, params, respond }) => {
    const connector = createMockLocalGrantConnector(
      params.connectorSlug,
      body.authMethod,
    );
    if (body.account?.intent === "add") {
      mockConnectorAccountDisplayNames.set(
        connector.id,
        body.account.displayName ?? null,
      );
    }
    upsertMockConnector(connector);
    return respond(200, connector);
  }),

  mockApi(connectorScopeDiffContract.getScopeDiff, ({ params, respond }) => {
    const connector = mockConnectors.find((candidate) => {
      return candidate.slug === params.connectorSlug;
    });
    const diff = connector ? mockConnectorScopeDiff(connector) : null;
    return diff
      ? respond(200, diff)
      : respond(404, {
          error: { message: "Connector not found", code: "NOT_FOUND" },
        });
  }),

  mockApi(
    connectorOauthDeviceAuthSessionContract.create,
    ({ params, respond }) => {
      const response = {
        ...defaultOauthDeviceAuthSessionStartResponse(params.connectorSlug),
        ...mockOauthDeviceAuthSessionStartResponse,
        connectorSlug:
          mockOauthDeviceAuthSessionStartResponse?.connectorSlug ??
          params.connectorSlug,
      };
      if (
        mockOauthDeviceAuthSessionStartResponse &&
        "verificationUriComplete" in mockOauthDeviceAuthSessionStartResponse &&
        mockOauthDeviceAuthSessionStartResponse.verificationUriComplete ===
          undefined
      ) {
        delete response.verificationUriComplete;
      }
      return respond(200, response);
    },
  ),

  mockApi(
    connectorOauthDeviceAuthSessionContract.poll,
    ({ params, respond }) => {
      const response =
        mockOauthDeviceAuthSessionPollResponses.shift() ??
        ({
          status: "complete",
          connector: createMockOauthDeviceAuthConnector(params.connectorSlug),
        } satisfies ConnectorOauthDeviceAuthSessionPollResponse);

      if (response.status === "complete") {
        upsertMockConnector(response.connector);
      }
      return respond(200, response);
    },
  ),

  mockApi(
    connectorExternalCodeSessionContract.create,
    ({ params, respond }) => {
      return respond(200, {
        ...defaultExternalCodeSessionStartResponse(params.connectorSlug),
        ...mockExternalCodeSessionStartResponse,
        connectorSlug:
          mockExternalCodeSessionStartResponse?.connectorSlug ??
          params.connectorSlug,
      });
    },
  ),

  mockApi(
    connectorExternalCodeSessionContract.complete,
    ({ body, params, respond }) => {
      if (!body.code) {
        return respond(400, {
          error: { message: "Missing authorization code", code: "BAD_REQUEST" },
        });
      }
      const connector = createMockExternalCodeConnector(
        params.connectorSlug,
        "cli",
      );
      upsertMockConnector(connector);
      return respond(200, { status: "complete", connector });
    },
  ),
];
