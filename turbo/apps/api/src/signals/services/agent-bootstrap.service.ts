import { computed, type Computed } from "ccstate";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  runEnvironmentSecretNames,
  type AgentRunRecord,
} from "./agent-run-execution.service";
import { buildAgentExecutionConfig } from "./agent-execution-config";
import { createBootstrapAgent } from "./agent-bootstrap-agent";
import {
  createAgentDisabledPaidTools,
  createAgentCustomConnectorDefinitions,
  createAgentEnvironment,
  type AgentEnvironmentSnapshot,
} from "./agent-bootstrap-resources";
import {
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  type AgentBootstrapCatalog,
  type AgentCatalogProjectionRow,
} from "./agent-bootstrap-catalog";
import { requestedProjectionConnectorSlugs } from "./connector-catalog-runtime.service";
import type { CapturedConnectorCatalogIdentity } from "./connector-catalog-runtime-projection.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
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

export interface AgentBootstrap {
  readonly memberMetadata: ExecutionMemberMetadata;
  readonly connectorSelection: AgentConnectorSelection;
  readonly permissionGrants: readonly ConnectorPermissionGrant[];
  readonly workflows: readonly SelectedAgentWorkflow[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly agent: AgentRunRecord | null;
  readonly disabledPaidToolIds: readonly string[];
  readonly environment: Omit<
    AgentEnvironmentSnapshot,
    "orgId" | "userId" | "secretNames"
  > & { readonly requestedSecretNames: readonly string[] };
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
    async (get): Promise<FeatureSwitchContext> => {
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
    const snapshot = await get(
      createAgentEnvironment(
        userId,
        orgId,
        runEnvironmentSecretNames(buildAgentExecutionConfig(agent.name)),
      ),
    );
    return {
      requestedSecretNames: snapshot.secretNames,
      variables: snapshot.variables,
      secrets: snapshot.secrets,
    };
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
      disabledPaidToolIds: disabledPaidTools.toolIds,
      environment,
      customConnectorDefinitions,
      catalog,
    };
  });
}
