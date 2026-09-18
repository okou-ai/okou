import { computed, type Computed } from "ccstate";
import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  agentRuns,
  agentSessions,
} from "@okouai/db/schema/agent-run-session-conversation";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, inArray } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  loadConnectorRuntimeSelection,
  getConnectorRuntimeConnector,
} from "./connector-catalog-runtime.service";
import { builtinConnectorCredentialStatusWithMethod } from "./connector-credential-status.service";
import { builtinConnectorCredentialStorageIsCompatible } from "./builtin-connector-credential-access.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { loadCurrentCustomConnectorStoredValues } from "./custom-connector-credential-access.service";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./custom-connector.service";

async function builtinMcpConnectors(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly sourceIds: Readonly<Record<string, string>>;
}): Promise<readonly McpConnector[]> {
  const slugs = Object.keys(args.sourceIds);
  if (slugs.length === 0) {
    return [];
  }
  const rows = await args.db
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
      agentSessions,
      and(
        eq(agentSessions.id, agentRuns.sessionId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .innerJoin(
      connectors,
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        inArray(connectors.id, Object.values(args.sourceIds)),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
      ),
    );
  if (rows.length === 0) {
    return [];
  }
  const snapshot = await loadConnectorRuntimeSelection(args.db, {
    requestedConnectorSlugs: slugs,
  });
  return rows.flatMap((row): McpConnector[] => {
    if (row.slug === null || args.sourceIds[row.slug] !== row.id) {
      return [];
    }
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
    return [
      {
        target: { kind: "builtin", connectorSlug: row.slug },
        connectionId: row.id,
        slug: row.slug,
        displayName: connector.catalogConnector.label,
        transport: mcp.transport,
        endpoint: mcp.endpoint,
        connected:
          builtinConnectorCredentialStatusWithMethod({
            method: runtimeMethod.method,
            automaticAuthType: row.automaticAuthType,
            storedNeedsReconnect: row.needsReconnect,
            tokenExpiresAt: row.tokenExpiresAt,
            now: nowDate(),
          }) === "available",
      },
    ];
  });
}

export function runMcpConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
}): Computed<Promise<readonly McpConnector[]>> {
  return computed(async (get): Promise<readonly McpConnector[]> => {
    const db = get(db$);
    const builtin = await builtinMcpConnectors({
      ...args,
      db,
      sourceIds: args.builtinConnectorSourceIds ?? {},
    });
    const memberConnectorIdsByCustomConnectorId = new Map(
      Object.entries(args.customConnectorSourceIds ?? {}),
    );
    const connectorIds = [...memberConnectorIdsByCustomConnectorId.keys()];
    if (connectorIds.length === 0) {
      return builtin;
    }
    const rows = await db
      .select({ connector: customConnectorDefinitionSelection() })
      .from(agentRuns)
      .innerJoin(
        agentSessions,
        and(
          eq(agentSessions.id, agentRuns.sessionId),
          eq(agentSessions.orgId, args.orgId),
          eq(agentSessions.userId, args.userId),
        ),
      )
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
    const storage = await loadCurrentCustomConnectorStoredValues(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitions,
      memberConnectorIdsByCustomConnectorId,
    });

    const custom = rows.map(({ connector }): McpConnector => {
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
      const response = serialiseCustomConnector({
        row: normaliseCustomConnectorRow(connector),
        valueMarkers,
        connectedAccountId:
          connector.authMode === "none"
            ? connectionId
            : access?.kind === "current" && access.connected
              ? access.memberConnectorId
              : null,
      });
      if (response.kind !== "mcp") {
        throw new Error("Run MCP connector query returned a non-MCP connector");
      }
      return {
        target: { kind: "custom", customConnectorId: response.id },
        connectionId,
        slug: response.slug,
        displayName: response.displayName,
        transport: response.transport,
        endpoint: response.endpoint,
        connected: response.connected,
      };
    });
    return [...builtin, ...custom];
  });
}
