import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { and, eq, isNotNull } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";
import { orderByCustomConnectorId } from "./custom-connector-order";

export interface CustomConnectorDefinitionVersion {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean;
}

export interface AgentConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
}

export interface AgentConnectorScopeSnapshot extends AgentConnectorScope {
  readonly customConnectorDefinitions: readonly CustomConnectorDefinitionVersion[];
}

export interface AgentConnectorSlugRow {
  readonly connectorSlug: string;
}

export interface AgentCustomConnectorRow {
  readonly customConnectorId: string;
  readonly permissionNames: readonly string[];
  readonly connectorSlug: string;
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean;
}

async function loadAgentAllowedConnectorSlugRows(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly AgentConnectorSlugRow[]> {
  return await db
    .select({ connectorSlug: userConnectors.connectorSlug })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );
}

async function loadAgentAllowedCustomConnectorRows(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly AgentCustomConnectorRow[]> {
  return await db
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
      connectorSlug: orgCustomConnectors.slug,
      storageVersion: orgCustomConnectors.storageVersion,
      skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
      isMcp: isNotNull(orgCustomConnectors.mcpEndpoint).mapWith(
        pgBooleanDecoder,
      ),
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
        eq(orgCustomConnectors.enabled, true),
      ),
    );
}

export function agentConnectorScopeFromRows(args: {
  readonly connectorRows: readonly AgentConnectorSlugRow[];
  readonly customConnectorRows: readonly AgentCustomConnectorRow[];
}): AgentConnectorScopeSnapshot {
  const allowedConnectorSlugs = args.connectorRows
    .flatMap((row) => {
      const parsed = connectorSlugSchema.safeParse(row.connectorSlug);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
  const customConnectorRows = orderByCustomConnectorId(
    args.customConnectorRows,
    (row) => {
      return row.customConnectorId;
    },
  );
  const allowedCustomConnectorIds = customConnectorRows.map((row) => {
    return row.customConnectorId;
  });
  const customConnectorGrants = customConnectorRows.map((row) => {
    return {
      customConnectorId: row.customConnectorId,
      permissionNames: [...row.permissionNames].sort(),
    };
  });
  const customConnectorDefinitions = customConnectorRows.map((row) => {
    return {
      customConnectorId: row.customConnectorId,
      connectorSlug: row.connectorSlug,
      storageVersion: row.storageVersion,
      skillStorageVersionId: row.skillStorageVersionId,
      isMcp: row.isMcp,
    };
  });
  return {
    allowedConnectorSlugs,
    allowedCustomConnectorIds,
    customConnectorGrants,
    customConnectorDefinitions,
  };
}

interface LoadAgentConnectorScopeArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

export async function loadAgentConnectorScope(
  db: ReadonlyDb,
  args: LoadAgentConnectorScopeArgs,
): Promise<AgentConnectorScopeSnapshot> {
  const [connectorRows, customConnectorRows] = await Promise.all([
    loadAgentAllowedConnectorSlugRows(db, args),
    loadAgentAllowedCustomConnectorRows(db, args),
  ]);
  return agentConnectorScopeFromRows({ connectorRows, customConnectorRows });
}

/** Transaction-safe form for writers that hold one PostgreSQL client. */
export async function loadAgentConnectorScopeSerial(
  db: ReadonlyDb,
  args: LoadAgentConnectorScopeArgs,
): Promise<AgentConnectorScopeSnapshot> {
  const connectorRows = await loadAgentAllowedConnectorSlugRows(db, args);
  const customConnectorRows = await loadAgentAllowedCustomConnectorRows(
    db,
    args,
  );
  return agentConnectorScopeFromRows({ connectorRows, customConnectorRows });
}
