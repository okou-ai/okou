import { command, computed, type Computed } from "ccstate";
import { waitUntil } from "../context/wait-until";
import { settle } from "../utils";
import {
  createModelFacts,
  createMemberModelBootstrap,
  type OrgModelBootstrap,
  type MemberModelBootstrap,
  type RunOrgMetadata,
} from "./model-bootstrap.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { BootstrapAgent } from "./agent-data.service";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import {
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  type AgentBootstrapCatalog,
  type AgentCatalogProjectionRow,
  type CapturedConnectorCatalogIdentity,
} from "./connector-catalog-runtime-projection.service";
import { requestedProjectionConnectorSlugs } from "./connector-catalog-runtime.service";
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

/** The only cross-graph read-only signal interface; no state or commands. */
export interface AgentRunContextSignals {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly agent$: Computed<Promise<BootstrapAgent | null>>;
  readonly orgMetadata$: Computed<Promise<RunOrgMetadata | null>>;
  readonly plan$: Computed<Promise<OrgPlanCapabilities | null>>;
  readonly modelFacts$: Computed<Promise<OrgModelBootstrap>>;
  readonly memberModels$: Computed<Promise<MemberModelBootstrap>>;
  readonly memberMetadata$: Computed<Promise<ExecutionMemberMetadata>>;
  readonly connectorSelection$: Computed<Promise<AgentConnectorSelection>>;
  readonly permissionGrants$: Computed<
    Promise<readonly ConnectorPermissionGrant[]>
  >;
  readonly workflows$: Computed<Promise<readonly SelectedAgentWorkflow[]>>;
  readonly featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>;
  readonly disabledPaidTools$: Computed<Promise<readonly string[]>>;
  readonly environment$: Computed<Promise<BootstrapEnvironment>>;
  readonly customConnectorDefinitions$: Computed<
    Promise<readonly CustomConnectorExecutionDefinition[]>
  >;
  readonly catalog$: Computed<Promise<AgentBootstrapCatalog>>;
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
export function createAgentRunContextSignals(
  userId: string,
  orgId: string,
  agentId: string,
): AgentRunContextSignals {
  const scope = { userId, orgId, agentId };
  const orgMetadata$ = createRunOrgMetadata(orgId);
  const plan$ = computed((get) => {
    return loadOrgPlanCapabilities(get(db$), orgId);
  });
  const modelFacts$ = computed(async (get) => {
    const [plan, org] = await Promise.all([get(plan$), get(orgMetadata$)]);
    return await get(createModelFacts(orgId, plan, org));
  });
  const memberModels$ = createMemberModelBootstrap(orgId, userId);
  const agent$ = computed(async (get): Promise<BootstrapAgent | null> => {
    const [[row], org] = await Promise.all([
      get(db$)
        .select({
          id: agents.id,
          name: agents.name,
          orgId: agents.orgId,
          owner: agents.owner,
          visibility: agents.visibility,
          displayName: agents.displayName,
          description: agents.description,
          sound: agents.sound,
          modelProviderId: agents.modelProviderId,
          selectedModel: agents.selectedModel,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1),
      get(orgMetadata$),
    ]);
    return row ? { ...row, defaultAgentId: org?.defaultAgentId ?? null } : null;
  });
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
  return {
    userId,
    orgId,
    agentId,
    agent$,
    orgMetadata$,
    plan$,
    modelFacts$,
    memberModels$,
    memberMetadata$,
    connectorSelection$,
    permissionGrants$,
    workflows$,
    featureSwitches$: featureSwitchContext$,
    disabledPaidTools$,
    environment$,
    customConnectorDefinitions$,
    catalog$,
  };
}

/** Start reads without awaiting them; preserve each cached rejection for consumers. */
export const preloadAgentRunContext$ = command(
  ({ get }, signals: AgentRunContextSignals, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const nodes: readonly Computed<Promise<unknown>>[] = [
      signals.agent$,
      signals.orgMetadata$,
      signals.plan$,
      signals.modelFacts$,
      signals.memberModels$,
      signals.memberMetadata$,
      signals.connectorSelection$,
      signals.permissionGrants$,
      signals.workflows$,
      signals.featureSwitches$,
      signals.disabledPaidTools$,
      signals.environment$,
      signals.customConnectorDefinitions$,
      signals.catalog$,
    ];
    for (const node of nodes) {
      waitUntil(settle(get(node)));
    }
  },
);

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

function createRunOrgMetadata(orgId: string) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({
        credits: orgMetadata.credits,
        modelMode: orgMetadata.modelMode,
        defaultAgentId: orgMetadata.defaultAgentId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    return row ?? null;
  });
}
