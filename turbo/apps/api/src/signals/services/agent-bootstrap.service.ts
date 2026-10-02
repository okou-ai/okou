import { computed, type Computed } from "ccstate";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createBootstrapAgent } from "./agent-bootstrap-agent";

import {
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  type AgentBootstrapCatalog,
  type AgentCatalogProjectionRow,
} from "./agent-bootstrap-catalog";
import { requestedProjectionConnectorSlugs } from "./connector-catalog-runtime.service";
import type { CapturedConnectorCatalogIdentity } from "./connector-catalog-runtime-projection.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  type CustomConnectorExecutionDefinition,
  customConnectorDefinitionSelection,
} from "./custom-connector-definition-selection";
import { agentConnectorScopeFromRows } from "./agent-connector-scope.service";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  createExecutionMemberMetadata,
  type ExecutionMemberMetadata,
} from "./execution-member-metadata.service";
import {
  createAgentConnectorSelection,
  type AgentConnectorSelection,
} from "./execution-agent-connectors.service";
import {
  createConnectorPermissionGrants,
  type ConnectorPermissionGrant,
} from "./execution-connector-permissions.service";
import {
  createAgentWorkflowSelection,
  type SelectedAgentWorkflow,
} from "./execution-agent-workflows.service";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { variables } from "@okouai/db/schema/variable";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

export interface BootstrapAgent {
  readonly id: string;
  readonly orgId: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly defaultAgentId: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
}

export interface BootstrapFeatureSwitchContext {
  readonly userId: string;
  readonly orgId: string;
  readonly email?: string;
  readonly overrides: Partial<Record<FeatureSwitchKey, boolean>>;
}

export interface BootstrapVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

export interface BootstrapEnvironment {
  readonly variables: readonly BootstrapVariable[];
}

export interface AgentBootstrap {
  readonly memberMetadata: ExecutionMemberMetadata;
  readonly connectorSelection: AgentConnectorSelection;
  readonly permissionGrants: readonly ConnectorPermissionGrant[];
  readonly workflows: readonly SelectedAgentWorkflow[];
  readonly featureSwitchContext: BootstrapFeatureSwitchContext;
  readonly agent: BootstrapAgent | null;
  readonly disabledPaidToolIds: readonly string[];
  readonly environment: BootstrapEnvironment;
  readonly customConnectorDefinitions: readonly CustomConnectorExecutionDefinition[];
  readonly catalog: AgentBootstrapCatalog;
}

/** The original speculative Promise is transported without a settled fallback. */
export interface PrefetchedAgentBootstrap {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly bootstrap: Promise<AgentBootstrap>;
}

function catalogMetadataSlugs(selection: AgentConnectorSelection) {
  return selection.customConnectors.flatMap((connector) => {
    const ref = connector.permissionBundleRef;
    const dependency =
      ref === null ? null : customConnectorPermissionBundleDependencySlug(ref);
    return dependency === null ? [] : [dependency];
  });
}

function normalizedCatalog(
  captured: CapturedConnectorCatalogIdentity,
  connectorSlugs: readonly ConnectorSlug[],
  rows: readonly AgentCatalogProjectionRow[],
): AgentBootstrapCatalog {
  return {
    identity: captured.identity ?? null,
    projection:
      captured.projection.kind === "ready"
        ? {
            kind: "ready",
            identity: captured.projection.projection.identity,
            connectorSlugs,
            filteredMethodKeys: [
              ...captured.projection.projection.filteredMethodKeys,
            ].sort(),
            rows,
          }
        : { kind: "unavailable", reason: captured.projection.reason },
  };
}

/** Compose the authoritative read definitions once per execution identity. */
export function createAgentBootstrap(
  userId: string,
  orgId: string,
  agentId: string,
): Computed<Promise<AgentBootstrap>> {
  const scope = { userId, orgId, agentId };
  const agent$ = createBootstrapAgent(agentId);
  const memberMetadata$ = createExecutionMemberMetadata(scope);
  const connectorSelection$ = createAgentConnectorSelection(scope);
  const permissionGrants$ = createConnectorPermissionGrants(scope);
  const workflows$ = createAgentWorkflowSelection(scope);
  const featureSwitchOverrides$ = userFeatureSwitchOverrides(orgId, userId);
  const disabledPaidTools$ = createAgentDisabledPaidTools(userId, orgId);
  const catalogIdentity$ = createAgentCatalogIdentity();
  const featureSwitchContext$ = computed(
    async (get): Promise<BootstrapFeatureSwitchContext> => {
      const [member, overrides] = await Promise.all([
        get(memberMetadata$),
        get(featureSwitchOverrides$),
      ]);
      return {
        orgId,
        userId,
        email: member.profile?.email ?? undefined,
        overrides,
      };
    },
  );
  const environment$ = computed(async (get) => {
    const agent = await get(agent$);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    const snapshot = await get(createAgentEnvironment(userId, orgId));
    return { variables: snapshot.variables };
  });
  const customConnectorDefinitions$ = computed(async (get) => {
    const selection = await get(connectorSelection$);
    return await get(
      createAgentCustomConnectorDefinitions(
        orgId,
        selection.customConnectors.map((connector) => {
          return connector.customConnectorId;
        }),
      ),
    );
  });
  const catalog$ = computed(async (get): Promise<AgentBootstrapCatalog> => {
    const [captured, selection] = await Promise.all([
      get(catalogIdentity$),
      get(connectorSelection$),
    ]);
    const scope = agentConnectorScopeFromRows({
      connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
        return {
          connectorSlug,
        };
      }),
      customConnectorRows: selection.customConnectors,
    });
    const metadataSlugs = catalogMetadataSlugs(selection);
    const connectorSlugs = requestedProjectionConnectorSlugs({
      runtimeConnectorSlugs: scope.allowedConnectorSlugs,
      metadataConnectorSlugs: metadataSlugs,
    });
    const rows =
      captured.projection.kind === "ready"
        ? await get(
            createAgentCatalogProjectionRows(
              captured.projection.projection.identity.projectionSetId,
              connectorSlugs,
            ),
          )
        : [];
    return normalizedCatalog(captured, connectorSlugs, rows);
  });
  return computed(async (get): Promise<AgentBootstrap> => {
    const [
      agent,
      memberMetadata,
      connectorSelection,
      permissionGrants,
      workflows,
      featureSwitchContext,
      disabledPaidTools,
      environment,
      customConnectorDefinitions,
      catalog,
    ] = await Promise.all([
      get(agent$),
      get(memberMetadata$),
      get(connectorSelection$),
      get(permissionGrants$),
      get(workflows$),
      get(featureSwitchContext$),
      get(disabledPaidTools$),
      get(environment$),
      get(customConnectorDefinitions$),
      get(catalog$),
    ]);
    return {
      agent,
      memberMetadata,
      connectorSelection,
      permissionGrants,
      workflows,
      featureSwitchContext,
      disabledPaidToolIds: disabledPaidTools,
      environment,
      customConnectorDefinitions,
      catalog,
    };
  });
}

function createAgentDisabledPaidTools(userId: string, orgId: string) {
  return computed(async (get): Promise<readonly string[]> => {
    const rows = await get(db$)
      .select({ toolId: userDisabledPaidTools.toolId })
      .from(userDisabledPaidTools)
      .where(
        and(
          eq(userDisabledPaidTools.orgId, orgId),
          eq(userDisabledPaidTools.userId, userId),
        ),
      )
      .orderBy(asc(userDisabledPaidTools.toolId));
    return rows.map((row) => {
      return row.toolId;
    });
  });
}

function createAgentCustomConnectorDefinitions(
  orgId: string,
  ids: readonly string[],
) {
  return computed(async (get) => {
    if (ids.length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
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
          eq(orgCustomConnectors.orgId, orgId),
          eq(orgCustomConnectors.enabled, true),
          inArray(orgCustomConnectors.id, [...ids]),
        ),
      );
    return rows.map((row): CustomConnectorExecutionDefinition => {
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
    });
  });
}

function createAgentEnvironment(userId: string, orgId: string) {
  return computed(async (get): Promise<BootstrapEnvironment> => {
    const rows = await get(db$)
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgId),
          eq(variables.type, "user"),
          or(
            eq(variables.userId, ORG_SENTINEL_USER_ID),
            eq(variables.userId, userId),
          ),
        ),
      );
    return { variables: rows };
  });
}
