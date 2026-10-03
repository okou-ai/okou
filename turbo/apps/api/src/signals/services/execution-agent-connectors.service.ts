import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorExecutionDefinition,
} from "./custom-connector-definition-selection";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

export interface AgentConnectorSelectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export interface SelectedCustomConnector {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly permissionBundleRef: string | null;
  readonly isMcp: boolean;
}

export interface AgentConnectorSelection {
  readonly builtinConnectorSlugs: readonly string[];
  readonly customConnectors: readonly SelectedCustomConnector[];
  readonly customConnectorDefinitions: readonly CustomConnectorExecutionDefinition[];
}

/** Read grants and complete custom definitions together; resolve accounts later. */
export function createAgentConnectorSelection(
  scope: AgentConnectorSelectionScope,
): Computed<Promise<AgentConnectorSelection>> {
  return computed(async (get) => {
    const db = get(db$);
    const [builtinRows, customRows] = await Promise.all([
      db
        .select({ connectorSlug: userBuiltinConnectors.connectorSlug })
        .from(userBuiltinConnectors)
        .where(
          and(
            eq(userBuiltinConnectors.orgId, scope.orgId),
            eq(userBuiltinConnectors.userId, scope.userId),
            eq(userBuiltinConnectors.agentId, scope.agentId),
          ),
        ),
      db
        .select({
          connector: customConnectorDefinitionSelection(),
          oauthConfig: orgCustomConnectorOauthConfigs,
          permissionNames: userCustomConnectors.permissionNames,
        })
        .from(userCustomConnectors)
        .innerJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
            eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
          ),
        )
        .leftJoin(
          orgCustomConnectorOauthConfigs,
          and(
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
            eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
          ),
        )
        .where(
          and(
            eq(userCustomConnectors.orgId, scope.orgId),
            eq(userCustomConnectors.userId, scope.userId),
            eq(userCustomConnectors.agentId, scope.agentId),
            eq(orgCustomConnectors.enabled, true),
          ),
        ),
    ]);
    return agentConnectorSelectionFromRows(builtinRows, customRows);
  });
}

export function agentConnectorSelectionFromRows(
  builtinRows: readonly { readonly connectorSlug: string }[],
  customRows: readonly (SelectedDefinitionRow & {
    readonly permissionNames: readonly string[];
  })[],
): AgentConnectorSelection {
  const customConnectors = customRows
    .map((row): SelectedCustomConnector => {
      return {
        customConnectorId: row.connector.id,
        connectorSlug: row.connector.slug,
        permissionNames: [...row.permissionNames].sort(),
        storageVersion: row.connector.storageVersion,
        skillStorageVersionId: row.connector.skillStorageVersionId,
        permissionBundleRef: row.connector.permissionBundleRef,
        isMcp: row.connector.mcpEndpoint !== null,
      };
    })
    .sort((a, b) => {
      return a.customConnectorId.localeCompare(b.customConnectorId);
    });
  return {
    builtinConnectorSlugs: builtinRows
      .map((row) => {
        return row.connectorSlug;
      })
      .sort(),
    customConnectors,
    customConnectorDefinitions: customRows.map(executionDefinitionFromRow),
  };
}

type SelectedDefinitionRow = {
  readonly connector: typeof orgCustomConnectors.$inferSelect;
  readonly oauthConfig:
    | typeof orgCustomConnectorOauthConfigs.$inferSelect
    | null;
};

function executionDefinitionFromRow(
  row: SelectedDefinitionRow,
): CustomConnectorExecutionDefinition {
  const definition = normaliseCustomConnectorRow(
    row.connector,
    row.oauthConfig,
  );
  const config = definition.oauthConfig;
  const shared = {
    id: definition.id,
    orgId: definition.orgId,
    slug: definition.slug,
    displayName: definition.displayName,
    fields: definition.fields,
    headerInjections: definition.headerInjections,
    queryInjections: definition.queryInjections,
    authMode: definition.authMode,
    skillMarkdown: definition.skillMarkdown,
    skillStorageVersionId: definition.skillStorageVersionId,
    storageVersion: definition.storageVersion,
    oauthConfig:
      config === null
        ? null
        : {
            providerAdapter: config.providerAdapter,
            clientId: config.clientId,
            encryptedClientSecret: config.encryptedClientSecret,
            authorizationUrl: config.authorizationUrl,
            tokenUrl: config.tokenUrl,
            tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
            pkceMethod: config.pkceMethod,
            scopes: config.scopes,
            authorizationParams: config.authorizationParams,
          },
  };
  return definition.kind === "http"
    ? {
        ...shared,
        kind: "http",
        prefixTemplates: definition.prefixTemplates,
        permissionBundleRef: definition.permissionBundleRef,
      }
    : {
        ...shared,
        kind: "mcp",
        endpoint: definition.endpoint,
        transport: definition.transport,
      };
}
