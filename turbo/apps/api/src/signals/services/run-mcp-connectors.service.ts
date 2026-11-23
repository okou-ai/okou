import { computed, type Computed } from "ccstate";
import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import { createImmutableConnectorRuntimeSelection } from "./connector-catalog-entries.service";
import { nowDate } from "../../lib/time";
import { getConnectorRuntimeConnector } from "./connector-catalog-runtime.service";
import { builtinConnectorCredentialStatusWithMethod } from "./connector-credential-status.service";
import { builtinConnectorCredentialStorageIsCompatible } from "./builtin-connector-credential-access.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { currentCustomConnectorStoredValues } from "./custom-connector-credential-access.service";
import { connectorAccountsByIds } from "./connector-account-lifecycle.service";
import {
  normaliseCustomConnectorRow,
  customConnectorIsConnected,
  customConnectorMissingRequiredFieldKeys,
} from "./custom-connector.service";

type McpRuntimeConnector = Omit<
  McpConnector,
  | "connectionStatus"
  | "reconnectReason"
  | "missingRequiredFields"
  | "configuredFieldKeys"
>;

interface RunMcpConnectorScope {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
}

function builtinMcpConnectors(
  scope$: Computed<Promise<RunMcpConnectorScope>>,
): Computed<Promise<readonly McpRuntimeConnector[]>> {
  const admitted$ = computed(async (get) => {
    const args = await get(scope$);
    const sourceIds = args.builtinConnectorSourceIds ?? {};
    if (Object.keys(sourceIds).length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        id: connectors.id,
        slug: connectors.connectorSlug,
        authMethod: connectors.authMethod,
        automaticAuthType: connectors.automaticAuthType,
        storageVersion: connectors.storageVersion,
        needsReconnect: connectors.needsReconnect,
        tokenExpiresAt: connectors.tokenExpiresAt,
      })
      .from(agentRuns)

      .innerJoin(
        connectors,
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          inArray(connectors.id, Object.values(sourceIds)),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
        ),
      );
    return rows.flatMap((row) => {
      return row.slug !== null && sourceIds[row.slug] === row.id
        ? [{ ...row, slug: row.slug }]
        : [];
    });
  });
  const catalogRequest$ = computed(async (get) => {
    const admitted = await get(admitted$);
    return admitted.length === 0
      ? null
      : {
          requestedConnectorSlugs: admitted.map((row) => {
            return row.slug;
          }),
        };
  });
  const catalog$ = createImmutableConnectorRuntimeSelection(catalogRequest$);
  return computed(async (get) => {
    const snapshot = await get(catalog$);
    if (!snapshot) {
      return [];
    }
    const admitted = await get(admitted$);
    // An admitted account whose connector left the catalog is omitted below,
    // as if it had never been authorized.
    return admitted.flatMap((row): McpRuntimeConnector[] => {
      const connector = getConnectorRuntimeConnector(snapshot, row.slug);
      const mcp = connector?.catalogConnector.mcp;
      const runtimeMethod = connector?.methods.get(row.authMethod);
      // Filter expected unavailable capabilities before resolving credentials.
      // Neither a current default nor another available method can replace this
      // exact account admitted to the Run.
      if (
        connector === undefined ||
        mcp === undefined ||
        runtimeMethod?.executable !== true ||
        !builtinConnectorCredentialStorageIsCompatible({
          runtimeMethod,
          automaticAuthType: row.automaticAuthType,
          storageVersion: row.storageVersion,
        })
      ) {
        return [];
      }
      const runtimeAvailable =
        builtinConnectorCredentialStatusWithMethod({
          method: runtimeMethod.method,
          automaticAuthType: row.automaticAuthType,
          storedNeedsReconnect: row.needsReconnect,
          tokenExpiresAt: row.tokenExpiresAt,
          now: nowDate(),
        }) === "available";
      return [
        {
          target: { kind: "builtin", connectorSlug: row.slug },
          connectionId: row.id,
          slug: row.slug,
          displayName: connector.catalogConnector.label,
          transport: mcp.transport,
          endpoint: mcp.endpoint,
          runtimeAvailable,
        },
      ];
    });
  });
}

function runMcpAccountMetadata(
  scope$: Computed<Promise<RunMcpConnectorScope>>,
) {
  const accountScope$ = computed(async (get) => {
    const args = await get(scope$);
    return {
      orgId: args.orgId,
      userId: args.userId,
      connectionIds: [
        ...Object.values(args.builtinConnectorSourceIds ?? {}),
        ...Object.values(args.customConnectorSourceIds ?? {}),
      ],
    };
  });
  const accounts$ = connectorAccountsByIds(accountScope$);
  return computed(async (get) => {
    return new Map(
      (await get(accounts$)).map((account) => {
        return [account.id, account];
      }),
    );
  });
}

function withAccountMetadata(
  connector: McpRuntimeConnector,
  account: ConnectorAccountConnection | undefined,
): McpConnector {
  // A successful exact-ID read can establish deletion. Keep the Run's
  // admitted identity and existing runtime result, including no-auth MCP.
  if (!account) {
    return {
      ...connector,
      connectionStatus: "reconnect-required",
      reconnectReason: "account_unavailable",
      missingRequiredFields: [],
      configuredFieldKeys: [],
    };
  }
  if (
    connectorAccountTargetKey(account.target) !==
    connectorAccountTargetKey(connector.target)
  ) {
    throw new Error(
      "Run MCP account target does not match its admitted connector",
    );
  }
  return {
    ...connector,
    connectionStatus: account.connectionStatus,
    reconnectReason: account.reconnectReason,
    missingRequiredFields: account.missingRequiredFields,
    configuredFieldKeys: account.configuredFieldKeys,
  };
}

function runCustomMcpScope(scope$: Computed<Promise<RunMcpConnectorScope>>) {
  return computed(async (get) => {
    const args = await get(scope$);
    const memberConnectorIdsByCustomConnectorId = new Map(
      Object.entries(args.customConnectorSourceIds ?? {}),
    );
    return {
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      memberConnectorIdsByCustomConnectorId,
      connectorIds: [...memberConnectorIdsByCustomConnectorId.keys()],
    };
  });
}

export function runMcpConnectorList(
  scope$: Computed<Promise<RunMcpConnectorScope>>,
): Computed<Promise<readonly McpConnector[]>> {
  const builtin$ = builtinMcpConnectors(scope$);
  const customScope$ = runCustomMcpScope(scope$);
  const customDefinitions$ = computed(async (get) => {
    const args = await get(customScope$);
    const { connectorIds } = args;
    if (connectorIds.length === 0) {
      return [];
    }
    return await get(db$)
      .select({ connector: customConnectorDefinitionSelection() })
      .from(agentRuns)

      .innerJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.orgId, agentRuns.orgId),
          inArray(orgCustomConnectors.id, connectorIds),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(orgCustomConnectors.enabled, true),
          eq(orgCustomConnectors.mcpTransport, "streamable-http"),
        ),
      )
      .orderBy(orgCustomConnectors.slug);
  });
  const storageScope$ = computed(async (get) => {
    const args = await get(customScope$);
    const rows = await get(customDefinitions$);
    const definitions = rows.flatMap(({ connector }) => {
      return connector.authMode === "none"
        ? []
        : [
            {
              id: connector.id,
              authMode: connector.authMode,
              storageVersion: connector.storageVersion,
            },
          ];
    });
    return {
      orgId: args.orgId,
      userId: args.userId,
      definitions,
      memberConnectorIdsByCustomConnectorId:
        args.memberConnectorIdsByCustomConnectorId,
    };
  });
  const storage$ = currentCustomConnectorStoredValues(storageScope$);
  const enrich$ = runMcpAccountMetadata(scope$);

  return computed(async (get): Promise<readonly McpConnector[]> => {
    const builtin = await get(builtin$);
    const accounts = await get(enrich$);
    const enrich = (connector: McpRuntimeConnector): McpConnector => {
      return withAccountMetadata(
        connector,
        accounts.get(connector.connectionId),
      );
    };
    const { connectorIds, memberConnectorIdsByCustomConnectorId } =
      await get(customScope$);
    if (connectorIds.length === 0) {
      return builtin.map(enrich);
    }
    const rows = await get(customDefinitions$);
    const storage = await get(storage$);
    const custom = rows.map(({ connector }): McpRuntimeConnector => {
      const connectionId = memberConnectorIdsByCustomConnectorId.get(
        connector.id,
      );
      if (connectionId === undefined) {
        throw new Error("Run MCP connector is missing its admitted account");
      }
      const access = storage.accesses.get(connector.id);
      if (connector.authMode !== "none" && !access) {
        throw new Error("Expected MCP connector credential access");
      }
      const valueMarkers = storage.values.flatMap((value) => {
        return value.connectorId === connector.id
          ? [
              {
                connectorId: connector.id,
                authMode: connector.authMode,
                storageVersion: connector.storageVersion,
                kind: value.kind,
                key: value.key,
              },
            ]
          : [];
      });
      const definition = normaliseCustomConnectorRow(connector);
      if (definition.kind !== "mcp") {
        throw new Error("Run MCP connector query returned a non-MCP connector");
      }
      const runtimeAvailable = customConnectorIsConnected({
        row: definition,
        connectedAccountId:
          connector.authMode === "none"
            ? connectionId
            : access?.kind === "current" && access.connected
              ? access.memberConnectorId
              : null,
        missingRequiredFields: customConnectorMissingRequiredFieldKeys({
          fields: definition.fields,
          markers: valueMarkers,
        }),
      });
      return {
        target: { kind: "custom", customConnectorId: definition.id },
        connectionId,
        slug: definition.slug,
        displayName: definition.displayName,
        transport: definition.transport,
        endpoint: definition.endpoint,
        runtimeAvailable,
      };
    });
    return [...builtin, ...custom].map(enrich);
  });
}
