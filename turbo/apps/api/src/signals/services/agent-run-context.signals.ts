import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { agents } from "@okouai/db/schema/agent";
import { command, computed, type Computed } from "ccstate";
import { performance } from "node:perf_hooks";
import { mapConcurrent } from "../../lib/map-concurrent";
import { waitUntil } from "../context/wait-until";
import { safeSync, settle } from "../utils";
import type { BootstrapAgent } from "./agent-data.service";
import {
  agentStorageReadPlan,
  captureAgentStorageContext,
  type AgentStorageContext,
} from "./agent-storage-context.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import {
  connectorSourceSnapshotsFromRows,
  type ConnectorSourceIdentity,
  type ConnectorSourceResult,
  type ConnectorSourceRow,
} from "./execution-connector-sources.service";
import type { MemberModelRouteContext } from "./effective-model-route.service";
import type { ModelCatalog } from "./model-catalog.service";
import {
  modelFactsFromSnapshot,
  type MemberModelBootstrap,
  type OrgModelBootstrap,
  type RunOrgMetadata,
} from "./model-bootstrap.service";
import {
  createManagedModelKeys,
  createModelPricing,
} from "./model-source-context.service";
import { createOfficialWorkflowCatalog } from "./official-workflow-context.signals";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  storageBaseIndexFromRows,
  storageBaseIndexReadPlan,
} from "./storage-index.service";
import { eq, sql } from "drizzle-orm";
import { db$ } from "../external/db";

import { createConnectorRuntimeSelection } from "./connector-catalog-entries.service";
import {
  agentConnectorScopeFromRows,
  type AgentConnectorScopeSnapshot,
} from "./agent-connector-scope.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import {
  pendingOkouTokenSecrets,
  resolveRunBodyEnvironment,
  type RunBodyEnvironment,
  selectedAgentRunVariables,
} from "./run-body-environment";
import {
  createAuthorizedConnectors,
  type AuthorizedConnectors,
} from "./authorized-connectors.service";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";
import type {
  AgentConnectorSelection,
  AgentConnectorSelectionScope,
} from "./execution-agent-connectors.service";
import { createAgentSelectionContext } from "./execution-agent-selection-context.service";
import type { SelectedAgentWorkflow } from "./execution-agent-workflows.service";
import type { ConnectorPermissionGrant } from "./execution-connector-permissions.service";
import {
  contextJsonProjection,
  contextProjectionSchema,
} from "./context-rowset";
import { createGlobalModelContext } from "./execution-global-model-context.service";
import { createExecutionOrgMemberContext } from "./execution-org-member-context.signals";
import type { ExecutionMemberMetadata } from "./execution-member-metadata.service";
import {
  type ExecutionOrgRows,
  executionExpiredCredits,
  executionOrgAttached,
  executionOrgMetadata,
  executionOrgPlan,
  executionOrgSlots,
} from "./execution-org-context.service";
import {
  createAgentEnvironment,
  connectorContextDuration,
  type BootstrapEnvironmentSnapshot,
  type BootstrapEnvironmentObservation,
  type BootstrapVariable,
  type ConnectorContextDuration,
} from "./execution-connector-environment.service";

import {
  executionCreditBalance,
  type ExecutionCreditBalance,
} from "./execution-credit-balance.service";
import {
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";

export interface BootstrapFeatureSwitchContext {
  readonly userId: string;
  readonly orgId: string;
  readonly email?: string;
  readonly overrides: Partial<Record<FeatureSwitchKey, boolean>>;
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
  readonly orgRows$: Computed<Promise<ExecutionOrgRows>>;
  readonly orgMetadata$: Computed<Promise<RunOrgMetadata | null>>;
  readonly plan$: Computed<Promise<OrgPlanCapabilities | null>>;
  readonly concurrencyCapacity$: Computed<Promise<number>>;
  readonly credits$: Computed<Promise<ExecutionCreditBalance | null>>;
  readonly modelFacts$: Computed<Promise<OrgModelBootstrap>>;
  readonly modelCatalog$: Computed<Promise<ModelCatalog>>;
  readonly memberModels$: Computed<Promise<MemberModelBootstrap>>;
  readonly memberRoutes$: Computed<Promise<MemberModelRouteContext>>;
  readonly managedModelKeys$: ReturnType<typeof createManagedModelKeys>;
  readonly modelPricing$: ReturnType<typeof createModelPricing>;
  readonly memberMetadata$: Computed<Promise<ExecutionMemberMetadata>>;
  readonly selectedImageModel$: Computed<Promise<ImageModel>>;
  readonly connectorSelection$: Computed<Promise<AgentConnectorSelection>>;
  /** Connectors the Agent may use, derived from its connector selection. */
  readonly connectorScope$: Computed<Promise<AgentConnectorScopeSnapshot>>;
  /** The Agent's permission grants, expanded into firewall policies. */
  readonly permissionPolicies$: Computed<Promise<FirewallPolicies | null>>;
  /** The Run body's own variables and placeholder secrets for this Agent. */
  readonly bodyEnvironment$: Computed<Promise<RunBodyEnvironment>>;
  readonly authorizedConnectors$: Computed<Promise<AuthorizedConnectors>>;
  readonly permissionGrants$: Computed<
    Promise<readonly ConnectorPermissionGrant[]>
  >;
  readonly workflows$: Computed<Promise<readonly SelectedAgentWorkflow[]>>;
  /** The accepted global Official Workflow catalog, shared across contexts. */
  readonly officialCatalog$: ReturnType<typeof createOfficialWorkflowCatalog>;
  /** Seed Skill rows read with the model catalog; shared across contexts. */
  readonly seedSkills$: ReturnType<
    typeof createGlobalModelContext
  >["seedSkills$"];
  readonly storage$: Computed<Promise<AgentStorageContext>>;
  readonly featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>;
  readonly disabledPaidTools$: Computed<Promise<readonly string[]>>;
  readonly environment$: Computed<Promise<BootstrapEnvironment>>;
  readonly customConnectorDefinitions$: Computed<
    Promise<readonly CustomConnectorExecutionDefinition[]>
  >;
  readonly catalog$: Computed<Promise<ConnectorRuntimeSelection | null>>;
  readonly connectors$: Computed<Promise<BootstrapConnectorData>>;
}

export interface BootstrapConnectorObservation extends BootstrapEnvironmentObservation {
  readonly sources: ConnectorContextDuration | undefined;
}

export interface BootstrapConnectorData {
  readonly observation: BootstrapConnectorObservation | undefined;
  readonly connectorAccounts: readonly BootstrapConnectorAccount[];
  readonly connectorSources: readonly ConnectorSourceResult[];
}

function catalogMetadataSlugs(selection: AgentConnectorSelection) {
  return selection.customConnectors.flatMap((connector) => {
    const ref = connector.permissionBundleRef;
    const dependency =
      ref === null ? null : customConnectorPermissionBundleDependencySlug(ref);
    return dependency === null ? [] : [dependency];
  });
}

export interface BootstrapConnectorAccount extends ConnectorSourceRow {
  readonly connectorId: string;
  readonly isDefault: boolean;
  readonly defaultEnabledForChats: boolean;
  readonly createdAt: Date;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorStateRevision: bigint;
  readonly orgId: string;
  readonly userId: string;
  readonly customDefinitionId: string | null;
  readonly providerAdapter:
    | NonNullable<
        CustomConnectorExecutionDefinition["oauthConfig"]
      >["providerAdapter"]
    | null;
}

/** Compose the authoritative read definitions once per execution identity. */
export function createAgentRunContextSignals(
  userId: string,
  orgId: string,
  agentId: string,
): AgentRunContextSignals {
  return createIdentityContext(userId, orgId, agentId);
}

/** Reuse by each group's authority key before wiring dependent computeds. */
export function matchAgentRunContextSignals(
  supplied: AgentRunContextSignals | undefined,
  userId: string,
  orgId: string,
  agentId: string,
): AgentRunContextSignals {
  if (
    supplied?.orgId === orgId &&
    supplied.userId === userId &&
    supplied.agentId === agentId
  ) {
    return supplied;
  }
  return createIdentityContext(userId, orgId, agentId, supplied);
}

function reusedOfficialCatalog(supplied: AgentRunContextSignals | undefined) {
  return supplied?.officialCatalog$ ?? createOfficialWorkflowCatalog();
}

function contextAgentSelection() {
  return {
    id: agents.id,
    name: agents.name,
    orgId: agents.orgId,
    owner: agents.owner,
    visibility: agents.visibility,
    displayName: agents.displayName,
    description: agents.description,
    sound: agents.sound,
  };
}

// Private graph ownership metadata; no package cache or public interface change.
const globalModelOwner = Symbol("agentRunGlobalModelOwner");
type OwnedAgentRunContext = AgentRunContextSignals & {
  readonly [globalModelOwner]: ReturnType<
    typeof createGlobalModelContext
  >["catalog$"];
};
function hasGlobalModelOwner(
  context: AgentRunContextSignals,
): context is OwnedAgentRunContext {
  return globalModelOwner in context;
}

/** The agent row rides on an unshared org statement; both gate enqueue. */
function contextAgentRowSql(agentId: string) {
  return sql`SELECT ${contextJsonProjection(contextAgentSelection())}
    FROM ${agents} WHERE ${eq(agents.id, agentId)} LIMIT 1`;
}

function createRunAgentRow(agentId: string) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select(contextAgentSelection())
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row ?? null;
  });
}

function capturedFeatureSwitchContext(
  scope: { readonly orgId: string; readonly userId: string },
  member: ExecutionMemberMetadata,
  overrides: BootstrapFeatureSwitchContext["overrides"],
  agent: BootstrapAgent | null,
): BootstrapFeatureSwitchContext {
  const context = {
    ...scope,
    email: member.profile?.email ?? undefined,
    overrides,
  };
  // Retained non-default executions are explicitly legacy, even for enabled members.
  const singleAgent =
    isFeatureEnabled(FeatureSwitchKey.SingleAgent, context) &&
    agent !== null &&
    agent.id === agent.defaultAgentId &&
    agent.orgId === scope.orgId &&
    (agent.visibility === "public" || agent.owner === scope.userId);
  return {
    ...context,
    overrides: { ...overrides, [FeatureSwitchKey.SingleAgent]: singleAgent },
  };
}

function requirePreparedContextAgent(agent: BootstrapAgent | null): void {
  if (!agent) {
    throw new Error("Agent disappeared after preparation authorization");
  }
}

function createOrgContextReferences(
  scope: { readonly orgId: string; readonly userId: string },
  supplied: AgentRunContextSignals | undefined,
) {
  const sharedOrg = supplied?.orgId === scope.orgId ? supplied : undefined;
  const sharedMember =
    sharedOrg?.userId === scope.userId ? sharedOrg : undefined;
  const globalReferences = supplied
    ? hasGlobalModelOwner(supplied)
      ? {
          managedModelKeys$: supplied.managedModelKeys$,
          modelPricing$: supplied.modelPricing$,
          catalog$: supplied[globalModelOwner],
          seedSkills$: supplied.seedSkills$,
        }
      : undefined
    : createGlobalModelContext();
  if (!globalReferences) {
    throw new Error("Agent run context has no global reference owner");
  }
  return { sharedOrg, sharedMember, globalReferences };
}

function createOrgContext(
  orgId: string,
  userId: string,
  agentId: string,
  supplied?: AgentRunContextSignals,
) {
  const memberContext = createExecutionOrgMemberContext(
    { userId, orgId },
    supplied?.orgId === orgId ? undefined : contextAgentRowSql(agentId),
  );
  const { sharedOrg, sharedMember, globalReferences } =
    createOrgContextReferences({ orgId, userId }, supplied);
  // Unshared member sources ride on the member statement read before enqueue.
  const providers = sharedMember ?? {
    memberModels$: memberContext.memberModels$,
  };
  const memberModels$ = providers.memberModels$;
  const modelSources = {
    memberRoutes$:
      sharedMember?.memberRoutes$ ??
      computed(async (get) => {
        return (await get(memberModels$)).member;
      }),
    managedModelKeys$: globalReferences.managedModelKeys$,
    modelPricing$: globalReferences.modelPricing$,
  };
  const orgRows$ = sharedOrg?.orgRows$ ?? memberContext.orgRows$;
  // A shared org statement was issued for another agent; read this one alone.
  const agentRow$ = sharedOrg
    ? createRunAgentRow(agentId)
    : computed(async (get) => {
        return contextProjectionSchema(contextAgentSelection())
          .nullable()
          .parse(executionOrgAttached(await get(orgRows$)));
      });
  const orgMetadata$ =
    sharedOrg?.orgMetadata$ ??
    computed(async (get) => {
      return executionOrgMetadata(await get(orgRows$));
    });
  const plan$ =
    sharedOrg?.plan$ ??
    computed(async (get) => {
      return executionOrgPlan(await get(orgRows$), orgId);
    });
  const concurrencyCapacity$ =
    sharedOrg?.concurrencyCapacity$ ??
    computed(async (get) => {
      const [plan, rows] = await Promise.all([get(plan$), get(orgRows$)]);
      const limit = totalConcurrencyLimit({
        baseLimit: cappedBaseConcurrencyLimit(plan?.baseConcurrencyLimit ?? 0),
        paidSlots: executionOrgSlots(rows),
      });
      return Number.isFinite(limit) ? limit : 0;
    });
  const modelCatalog$ = globalReferences.catalog$;
  const modelFacts$ =
    sharedOrg?.modelFacts$ ??
    computed(async (get) => {
      const [capabilities, org, catalog] = await Promise.all([
        get(plan$),
        get(orgMetadata$),
        get(modelCatalog$),
      ]);
      return modelFactsFromSnapshot(orgId, capabilities, org, catalog);
    });
  return {
    memberContext,
    orgRows$,
    agentRow$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    modelFacts$,
    globalReferences,
    memberModels$,
    modelSources: {
      ...modelSources,
      modelCatalog$:
        sharedOrg?.modelCatalog$ ??
        computed(async (get) => {
          return (await get(modelFacts$)).catalog;
        }),
    },
  };
}

function createSelectedImageModel(
  memberMetadata$: Computed<Promise<ExecutionMemberMetadata>>,
) {
  return computed(async (get) => {
    const stored = (await get(memberMetadata$)).preferences?.selectedImageModel;
    return isImageModelId(stored) ? stored : DEFAULT_IMAGE_MODEL;
  });
}

function createIdentityContext(
  userId: string,
  orgId: string,
  agentId: string,
  supplied?: AgentRunContextSignals,
): OwnedAgentRunContext {
  const scope = { userId, orgId, agentId };
  const {
    memberContext,
    orgRows$,
    agentRow$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    modelFacts$,
    globalReferences,
    memberModels$,
    modelSources,
  } = createOrgContext(orgId, userId, agentId, supplied);
  const sharedMember =
    supplied?.orgId === orgId && supplied.userId === userId
      ? supplied
      : undefined;
  const agent$ = computed(async (get): Promise<BootstrapAgent | null> => {
    const [row, org] = await Promise.all([get(agentRow$), get(orgMetadata$)]);
    return row ? { ...row, defaultAgentId: org?.defaultAgentId ?? null } : null;
  });
  const memberMetadata$ =
    sharedMember?.memberMetadata$ ?? memberContext.metadata$;
  const credits$ =
    sharedMember?.credits$ ??
    computed(async (get): Promise<ExecutionCreditBalance | null> => {
      const [org, rows, pack] = await Promise.all([
        get(orgMetadata$),
        get(orgRows$),
        get(memberContext.packCredits$),
      ]);
      return executionCreditBalance(org, executionExpiredCredits(rows), pack);
    });
  const featureSwitchContext$ =
    sharedMember?.agentId === agentId
      ? sharedMember.featureSwitches$
      : computed(async (get): Promise<BootstrapFeatureSwitchContext> => {
          const [member, overrides, agent] = await Promise.all([
            get(memberMetadata$),
            get(memberContext.overrides$),
            get(agent$),
          ]);
          return capturedFeatureSwitchContext(scope, member, overrides, agent);
        });
  const connectorContext = createConnectorContextGroups(
    userId,
    orgId,
    agentId,
    featureSwitchContext$,
  );
  const storage$ = computed(async (get): Promise<AgentStorageContext> => {
    const requests = agentStorageReadPlan(scope);
    const db = get(db$);
    return captureAgentStorageContext(
      requests,
      await (async () => {
        const readPlan = storageBaseIndexReadPlan(requests);
        if (readPlan === null) {
          return new Map();
        }
        const rows = await db
          .select(readPlan.columns)
          .from(readPlan.from)
          .innerJoin(readPlan.requested, readPlan.requestedCondition)
          .leftJoin(readPlan.head, readPlan.headCondition)
          .leftJoin(readPlan.exact, readPlan.exactCondition)
          .leftJoin(readPlan.cache, readPlan.cacheCondition);
        return storageBaseIndexFromRows(rows);
      })(),
    );
  });
  const disabledPaidTools$ =
    sharedMember?.disabledPaidTools$ ?? memberContext.disabledPaidTools$;
  const environment$ = computed(async (get) => {
    requirePreparedContextAgent(await get(agent$));
    const snapshot = await get(connectorContext.environmentSnapshot$);
    return { variables: snapshot.variables };
  });
  return {
    [globalModelOwner]: globalReferences.catalog$,
    ...scope,
    agent$,
    orgRows$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    credits$,
    modelFacts$,
    memberModels$,
    ...modelSources,
    memberMetadata$,
    selectedImageModel$:
      sharedMember?.selectedImageModel$ ??
      createSelectedImageModel(memberMetadata$),
    ...connectorContext.signals,
    officialCatalog$: reusedOfficialCatalog(supplied),
    seedSkills$: globalReferences.seedSkills$,
    storage$,
    featureSwitches$: featureSwitchContext$,
    disabledPaidTools$,
    environment$,
  };
}

/**
 * Trigger each group immediately after context creation, before authorization in
 * prepareNormalSendContext$, or at pick start when no matching context is passed.
 * Cached failures remain authoritative.
 */
export const preloadAgentRunContext$ = command(
  ({ get }, signals: AgentRunContextSignals, signal: AbortSignal): void => {
    signal.throwIfAborted();
    // Start the launch-critical dependency chains before independent projections.
    // All nodes start in this turn; the starter awaits none of them.
    const nodes: readonly Computed<Promise<unknown>>[] = [
      signals.catalog$,
      signals.authorizedConnectors$,
      signals.connectors$,
      signals.storage$,
      signals.agent$,
      signals.orgRows$,
      signals.orgMetadata$,
      signals.plan$,
      signals.concurrencyCapacity$,
      signals.credits$,
      signals.modelFacts$,
      signals.modelCatalog$,
      signals.memberModels$,
      signals.memberRoutes$,
      signals.memberMetadata$,
      signals.selectedImageModel$,
      signals.connectorSelection$,
      signals.permissionGrants$,
      signals.workflows$,
      signals.featureSwitches$,
      signals.disabledPaidTools$,
      signals.environment$,
      signals.customConnectorDefinitions$,
      signals.managedModelKeys$,
      signals.modelPricing$,
    ];
    for (const node of nodes) {
      waitUntil(settle(get(node)));
    }
  },
);

function bootstrapConnectorSnapshot(
  userId: string,
  orgId: string,
  snapshot: BootstrapEnvironmentSnapshot,
  definitions: readonly CustomConnectorExecutionDefinition[],
) {
  const startedAt = performance.now();
  const byId = new Map(
    definitions.map((definition) => {
      return [definition.id, definition];
    }),
  );
  const accounts = snapshot.accounts.map((row): BootstrapConnectorAccount => {
    const definition =
      row.customConnectorId === null
        ? undefined
        : byId.get(row.customConnectorId);
    return {
      ...row,
      connectorId: row.id,
      customOrgId: definition?.orgId ?? null,
      customEnabled: definition !== undefined,
      customDefinitionId: definition?.id ?? null,
      providerAdapter: definition?.oauthConfig?.providerAdapter ?? null,
      definitionAuthMode: definition?.authMode ?? null,
      definitionStorageVersion: definition?.storageVersion ?? null,
      definitionMcpTransport:
        definition?.kind === "mcp" ? definition.transport : null,
    };
  });
  const sources = accounts.flatMap((row): ConnectorSourceIdentity[] => {
    return row.customConnectorId !== null
      ? [
          {
            kind: "custom",
            customConnectorId: row.customConnectorId,
            sourceId: row.id,
          },
        ]
      : row.connectorSlug !== null
        ? [
            {
              kind: "builtin",
              connectorSlug: row.connectorSlug,
              sourceId: row.id,
            },
          ]
        : [];
  });
  const result = {
    accounts,
    sources: connectorSourceSnapshotsFromRows(
      { userId, orgId, sources },
      accounts,
      snapshot.values,
    ),
  };
  const duration = connectorContextDuration(startedAt);
  const observation = safeSync(() => {
    return snapshot.observation
      ? { ...snapshot.observation, sources: duration }
      : undefined;
  });
  return {
    ...result,
    observation: "ok" in observation ? observation.ok : undefined,
  };
}

export interface EagerConnectorCredentialObservation {
  readonly builtinResolve: ConnectorContextDuration | undefined;
  readonly builtinDecrypt: ConnectorContextDuration | undefined;
  /** Selected credential attempts, including settled failures; not total Run KMS. */
  readonly builtinDecryptCount: number;
}

export interface EagerConnectorCredentialContext {
  readonly credentials$: Computed<
    Promise<{
      readonly credentials: ReadonlyMap<
        string,
        Awaited<ReturnType<typeof settle<string>>>
      >;
      readonly observation: EagerConnectorCredentialObservation | undefined;
    }>
  >;
}

/** Connect the lazy credential read while constructing its owning graph. */
export function createEagerConnectorCredentialContext(
  input$: Computed<
    Promise<{
      readonly credentials: readonly {
        readonly id: string;
        readonly encryptedValue: string;
      }[];
      readonly resolveStartedAt: number;
    }>
  >,
): EagerConnectorCredentialContext {
  const credentials$ = computed(async (get) => {
    const { credentials, resolveStartedAt } = await get(input$);
    const decryptStartedAt = performance.now();
    const decrypted = await mapConcurrent(
      credentials,
      4,
      async (credential) => {
        return [
          credential.id,
          await settle(decryptStoredSecretValue(credential.encryptedValue)),
        ] as const;
      },
    );
    const result = new Map(decrypted);
    const observation = safeSync((): EagerConnectorCredentialObservation => {
      return {
        builtinDecrypt: connectorContextDuration(decryptStartedAt),
        builtinResolve: connectorContextDuration(resolveStartedAt),
        builtinDecryptCount: result.size,
      };
    });
    return {
      credentials: result,
      observation: "ok" in observation ? observation.ok : undefined,
    };
  });
  return { credentials$ };
}

/** Connector groups share one account/environment statement and one catalog capture. */
function createConnectorContextGroups(
  userId: string,
  orgId: string,
  agentId: string,
  featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>,
) {
  const identity$ = computed(() => {
    return Promise.resolve({ userId, orgId, agentId });
  });
  return createExecutionConnectorSources(identity$, featureSwitches$);
}

/**
 * Read current sources for an already-authorized execution identity.
 * Keep connector revisions and credential values in the same statement.
 */
export function createExecutionConnectorSources(
  identity$: Computed<Promise<AgentConnectorSelectionScope>>,
  featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>,
  environmentSnapshot$: Computed<
    Promise<BootstrapEnvironmentSnapshot>
  > = createAgentEnvironment(identity$),
) {
  const { connectorSelection$, permissionGrants$, workflows$ } =
    createAgentSelectionContext(identity$, featureSwitches$);
  const customConnectorDefinitions$ = computed(async (get) => {
    return (await get(connectorSelection$)).customConnectorDefinitions;
  });
  const connectorSnapshot$ = computed(async (get) => {
    const { userId, orgId } = await get(identity$);
    const [snapshot, definitions] = await Promise.all([
      get(environmentSnapshot$),
      get(customConnectorDefinitions$),
    ]);
    return bootstrapConnectorSnapshot(userId, orgId, snapshot, definitions);
  });
  const connectorScope$ = computed(async (get) => {
    const selection = await get(connectorSelection$);
    return agentConnectorScopeFromRows({
      connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
        return { connectorSlug };
      }),
      customConnectorRows: selection.customConnectors,
    });
  });
  const requested$ = computed(async (get) => {
    const [selection, scope] = await Promise.all([
      get(connectorSelection$),
      get(connectorScope$),
    ]);
    if (
      scope.allowedConnectorSlugs.length === 0 &&
      scope.allowedCustomConnectorIds.length === 0
    ) {
      return null;
    }
    return {
      runtimeConnectorSlugs: scope.allowedConnectorSlugs,
      metadataConnectorSlugs: catalogMetadataSlugs(selection),
    };
  });
  const catalog$ = createConnectorRuntimeSelection(requested$);
  const authorizedConnectors$ = createAuthorizedConnectors(
    connectorSelection$,
    catalog$,
  );
  const connectors$ = computed(async (get): Promise<BootstrapConnectorData> => {
    const snapshot = await get(connectorSnapshot$);
    return {
      connectorAccounts: snapshot.accounts,
      connectorSources: snapshot.sources,
      observation: snapshot.observation,
    };
  });
  const bodyEnvironment$ = computed(async (get) => {
    const { agentId } = await get(identity$);
    const snapshot = await get(environmentSnapshot$);
    return resolveRunBodyEnvironment({
      runVars: selectedAgentRunVariables(agentId),
      runSecrets: pendingOkouTokenSecrets(undefined),
      persistedEnvironment: { variables: snapshot.variables },
      canonicalOkouRuntime: true,
    });
  });
  const permissionPolicies$ = computed(async (get) => {
    const [grants, scope, catalog] = await Promise.all([
      get(permissionGrants$),
      get(connectorScope$),
      get(catalog$),
    ]);
    const stored = permissionGrantsToFirewallPolicies(
      grants.map(({ connectorSlug, permission, action }) => {
        return { connectorSlug, permission, action };
      }),
    );
    if (
      scope.allowedConnectorSlugs.length === 0 &&
      scope.allowedCustomConnectorIds.length === 0
    ) {
      return stored;
    }
    if (!catalog) {
      throw new Error("Scoped connector catalog is missing from bootstrap");
    }
    return await expandConnectorServerFirewallPolicies({
      catalog: catalog.serverFirewalls,
      stored,
      connectorSlugs: [...scope.allowedConnectorSlugs],
    });
  });
  return {
    environmentSnapshot$,
    signals: {
      connectorSelection$,
      connectorScope$,
      authorizedConnectors$,
      permissionGrants$,
      workflows$,
      customConnectorDefinitions$,
      catalog$,
      connectors$,
      bodyEnvironment$,
      permissionPolicies$,
    },
  };
}
