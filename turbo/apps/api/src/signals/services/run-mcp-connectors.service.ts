import { computed, type Computed } from "ccstate";
import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  agentRuns,
  agentSessions,
} from "@okouai/db/schema/agent-run-session-conversation";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { loadCurrentCustomConnectorStoredValues } from "./custom-connector-credential-access.service";
import { loadRunBuiltinMcpConnectors } from "./run-builtin-mcp-connectors.service";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./custom-connector.service";

export function runMcpConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinMcpSourceIds?: Readonly<Record<string, string>>;
}): Computed<Promise<readonly McpConnector[]>> {
  return computed(async (get): Promise<readonly McpConnector[]> => {
    const memberConnectorIdsByCustomConnectorId = new Map(
      Object.entries(args.customConnectorSourceIds ?? {}),
    );
    const connectorIds = [...memberConnectorIdsByCustomConnectorId.keys()];
    if (
      connectorIds.length === 0 &&
      Object.keys(args.builtinMcpSourceIds ?? {}).length === 0
    ) {
      return [];
    }
    const db = get(db$);
    const [ownedRun] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        agentSessions,
        and(
          eq(agentSessions.id, agentRuns.sessionId),
          eq(agentSessions.orgId, args.orgId),
          eq(agentSessions.userId, args.userId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
        ),
      )
      .limit(1);
    if (ownedRun === undefined) {
      return [];
    }
    const builtin = await loadRunBuiltinMcpConnectors({
      db,
      orgId: args.orgId,
      userId: args.userId,
      sourceIds: args.builtinMcpSourceIds ?? {},
    });
    if (connectorIds.length === 0) {
      return builtin;
    }
    const rows = await db
      .select({ connector: customConnectorDefinitionSelection() })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          inArray(orgCustomConnectors.id, connectorIds),
          eq(orgCustomConnectors.enabled, true),
          eq(orgCustomConnectors.mcpTransport, "streamable-http"),
        ),
      )
      .orderBy(orgCustomConnectors.slug);

    const definitions = rows.map(({ connector }) => {
      return {
        id: connector.id,
        authMode: connector.authMode,
        storageVersion: connector.storageVersion,
      };
    });
    const storage = await loadCurrentCustomConnectorStoredValues(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitions,
      memberConnectorIdsByCustomConnectorId,
    });

    const custom = rows.map(({ connector }): McpConnector => {
      const access = storage.accesses.get(connector.id);
      if (!access) {
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
          access.kind === "current" && access.connected
            ? access.memberConnectorId
            : null,
      });
      if (response.kind !== "mcp") {
        throw new Error("Run MCP connector query returned a non-MCP connector");
      }
      return {
        kind: "custom",
        id: response.id,
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
