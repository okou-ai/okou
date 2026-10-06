import { command, computed, type Computed } from "ccstate";
import { performance } from "node:perf_hooks";
import {
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisition,
  type PgPoolAcquisitionCapture,
} from "../../lib/db-instrumentation";
import {
  createOrgModelSources,
  createGatewayModelSources,
  createManagedModelKeys,
  createModelPricing,
} from "./model-source-context.service";
import { waitUntil } from "../context/wait-until";
import {
  agentStorageReadPlan,
  captureAgentStorageContext,
  agentStorageCacheSnapshot,
  type AgentStorageContext,
} from "./agent-storage-context.service";
import type { ExecutionStorageCacheRows } from "./execution-storage-cache-read.service";
import { readStorageBaseIndex } from "./storage-index.service";
import {
  createOfficialWorkflowFacts,
  createOfficialWorkflowCatalog,
  type OfficialWorkflowContextFacts,
} from "./official-workflow-context.signals";
import type {
  OrgModelBootstrap,
  MemberModelBootstrap,
  RunOrgMetadata,
} from "./model-bootstrap.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { agents } from "@okouai/db/schema/agent";
import { z } from "zod";
import {
  pgInt8ToBigIntDecoder,
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { mapConcurrent } from "../../lib/map-concurrent";
import { safeSync, settle } from "../utils";
import { decryptStoredSecretValue } from "./crypto.utils";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import {
  connectorSourceSnapshotsFromRows,
  type ConnectorSourceRow,
  type ConnectorSourceIdentity,
  type ConnectorSourceResult,
} from "./execution-connector-sources.service";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { BootstrapAgent } from "./agent-data.service";

import {
  createConnectorRuntimeSelection,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
import { agentConnectorScopeFromRows } from "./agent-connector-scope.service";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";
import type { ExecutionMemberMetadata } from "./execution-member-metadata.service";
import { createExecutionMemberContext } from "./execution-member-context.service";
import {
  createExecutionOrgRows,
  executionOrgMetadata,
  executionOrgPlan,
  executionOrgSlots,
  executionExpiredCredits,
  executionOrgPolicies,
} from "./execution-org-context.service";
import { orgModelPolicyFactsFromSnapshot } from "./model-policy.service";
import type { AgentConnectorSelection } from "./execution-agent-connectors.service";
import { createAgentSelectionContext } from "./execution-agent-selection-context.service";
import { createProviderContext } from "./execution-provider-context.service";
import { createGlobalModelContext } from "./execution-global-model-context.service";
import type { ConnectorPermissionGrant } from "./execution-connector-permissions.service";
import type { SelectedAgentWorkflow } from "./execution-agent-workflows.service";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import {
  createUsageAllowanceContext,
  type UsageAllowanceContext,
} from "./usage-allowance-context.service";

import {
  executionCreditBalance,
  type ExecutionCreditBalance,
} from "./execution-credit-balance.service";
import { now } from "../../lib/time";
import {
  totalConcurrencyLimit,
  cappedBaseConcurrencyLimit,
} from "./org-concurrency-entitlements.service";

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
  readonly orgRows$: ReturnType<typeof createExecutionOrgRows>;
  readonly orgMetadata$: Computed<Promise<RunOrgMetadata | null>>;
  readonly plan$: Computed<Promise<OrgPlanCapabilities | null>>;
  readonly concurrencyCapacity$: Computed<Promise<number>>;
  readonly allowance$: Computed<Promise<UsageAllowanceContext>>;
  readonly credits$: Computed<Promise<ExecutionCreditBalance | null>>;
  readonly modelFacts$: Computed<Promise<OrgModelBootstrap>>;
  readonly memberModels$: Computed<Promise<MemberModelBootstrap>>;
  readonly orgModelSources$: ReturnType<typeof createOrgModelSources>;
  readonly gatewayModelSources$: ReturnType<typeof createGatewayModelSources>;
  readonly managedModelKeys$: ReturnType<typeof createManagedModelKeys>;
  readonly modelPricing$: ReturnType<typeof createModelPricing>;
  readonly memberMetadata$: Computed<Promise<ExecutionMemberMetadata>>;
  readonly connectorSelection$: Computed<Promise<AgentConnectorSelection>>;
  readonly permissionGrants$: Computed<
    Promise<readonly ConnectorPermissionGrant[]>
  >;
  readonly workflows$: Computed<Promise<readonly SelectedAgentWorkflow[]>>;
  readonly officialCatalog$: ReturnType<typeof createOfficialWorkflowCatalog>;
  readonly officialWorkflows$: Computed<Promise<OfficialWorkflowContextFacts>>;
  readonly storage$: Computed<Promise<AgentStorageContext>>;
  readonly storageCache$: Computed<
    Promise<{
      readonly keys: ReadonlySet<string>;
      readonly rows: ExecutionStorageCacheRows;
    }>
  >;
  readonly featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>;
  readonly disabledPaidTools$: Computed<Promise<readonly string[]>>;
  readonly environment$: Computed<Promise<BootstrapEnvironment>>;
  readonly customConnectorDefinitions$: Computed<
    Promise<readonly CustomConnectorExecutionDefinition[]>
  >;
  readonly catalog$: Computed<Promise<ConnectorRuntimeSelection | null>>;
  readonly connectors$: Computed<Promise<BootstrapConnectorData>>;
}

interface ConnectorContextDuration {
  readonly durationMs: number;
  readonly finishedAt: number;
}

interface BootstrapEnvironmentObservation {
  readonly query: ConnectorContextDuration | undefined;
  readonly materialize: ConnectorContextDuration | undefined;
  readonly acquisitions: readonly PgPoolAcquisition[];
  readonly returnedRowCount: number;
  readonly accountCount: number;
  readonly customAccountCount: number;
  readonly storedValueCount: number;
}

export interface BootstrapConnectorObservation extends BootstrapEnvironmentObservation {
  readonly sources: ConnectorContextDuration | undefined;
}

function connectorContextDuration(
  startedAt: number,
): ConnectorContextDuration | undefined {
  const result = safeSync(() => {
    return {
      durationMs: Math.max(0, performance.now() - startedAt),
      finishedAt: now(),
    };
  });
  return "ok" in result ? result.ok : undefined;
}

function bootstrapEnvironmentObservation(args: {
  readonly query: ConnectorContextDuration | undefined;
  readonly materialize: ConnectorContextDuration | undefined;
  readonly acquisitions: readonly PgPoolAcquisition[];
  readonly returnedRowCount: number;
  readonly accounts: readonly Pick<ConnectorSourceRow, "customConnectorId">[];
  readonly storedValueCount: number;
}): BootstrapEnvironmentObservation | undefined {
  const result = safeSync(() => {
    return {
      query: args.query,
      materialize: args.materialize,
      acquisitions: [...args.acquisitions],
      returnedRowCount: args.returnedRowCount,
      accountCount: args.accounts.length,
      customAccountCount: args.accounts.filter((account) => {
        return account.customConnectorId !== null;
      }).length,
      storedValueCount: args.storedValueCount,
    };
  });
  return "ok" in result ? result.ok : undefined;
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

function hasSelectedOfficialWorkflow(
  workflows: readonly SelectedAgentWorkflow[],
) {
  return workflows.some((workflow) => {
    return workflow.officialDefinitionName !== null;
  });
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
    modelProviderId: agents.modelProviderId,
    selectedModel: agents.selectedModel,
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

function createModelSourceGroups(
  orgId: string,
  userId: string,
  supplied?: AgentRunContextSignals,
) {
  const sharedOrg = supplied?.orgId === orgId ? supplied : undefined;
  const sharedMember = sharedOrg?.userId === userId ? sharedOrg : undefined;
  const providers =
    sharedMember ?? createProviderContext(orgId, userId, !sharedOrg);
  const globalReferences = supplied
    ? hasGlobalModelOwner(supplied)
      ? {
          managedModelKeys$: supplied.managedModelKeys$,
          modelPricing$: supplied.modelPricing$,
          catalog$: supplied[globalModelOwner],
        }
      : undefined
    : createGlobalModelContext();
  if (!globalReferences) {
    throw new Error("Agent run context has no global reference owner");
  }
  return {
    orgModelSources$: sharedOrg?.orgModelSources$ ?? providers.orgModelSources$,
    memberModels$: providers.memberModels$,
    gatewayModelSources$:
      sharedOrg?.gatewayModelSources$ ?? createGatewayModelSources(orgId),
    managedModelKeys$: globalReferences.managedModelKeys$,
    modelPricing$: globalReferences.modelPricing$,
    globalReferences,
  };
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
): BootstrapFeatureSwitchContext {
  return { ...scope, email: member.profile?.email ?? undefined, overrides };
}

function requirePreparedContextAgent(agent: BootstrapAgent | null): void {
  if (!agent) {
    throw new Error("Agent disappeared after preparation authorization");
  }
}

function createOrgContext(
  orgId: string,
  userId: string,
  supplied?: AgentRunContextSignals,
) {
  const { globalReferences, memberModels$, ...modelSources } =
    createModelSourceGroups(orgId, userId, supplied);
  const sharedOrg = supplied?.orgId === orgId ? supplied : undefined;
  const orgRows$ = sharedOrg?.orgRows$ ?? createExecutionOrgRows(orgId);
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
  const allowance$ =
    sharedOrg?.allowance$ ?? createUsageAllowanceContext(orgId);
  const modelFacts$ =
    sharedOrg?.modelFacts$ ??
    computed(async (get) => {
      const [capabilities, org, catalog, rows] = await Promise.all([
        get(plan$),
        get(orgMetadata$),
        get(modelCatalog$),
        get(orgRows$),
      ]);
      const policies = executionOrgPolicies(rows);
      return {
        orgId,
        org,
        capabilities,
        catalog,
        policies,
        policyFacts: orgModelPolicyFactsFromSnapshot({
          catalog,
          orgId,
          orgPlanCapabilities: capabilities,
          stored: policies,
        }),
      };
    });
  return {
    orgRows$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    allowance$,
    modelFacts$,
    globalReferences,
    memberModels$,
    modelSources,
  };
}

function createIdentityContext(
  userId: string,
  orgId: string,
  agentId: string,
  supplied?: AgentRunContextSignals,
): AgentRunContextSignals {
  const scope = { userId, orgId, agentId };
  const {
    orgRows$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    allowance$,
    modelFacts$,
    globalReferences,
    memberModels$,
    modelSources,
  } = createOrgContext(orgId, userId, supplied);
  const sharedMember =
    supplied?.orgId === orgId && supplied.userId === userId
      ? supplied
      : undefined;
  const agentRow$ = createRunAgentRow(agentId);
  const agent$ = computed(async (get): Promise<BootstrapAgent | null> => {
    const [row, org] = await Promise.all([get(agentRow$), get(orgMetadata$)]);
    return row ? { ...row, defaultAgentId: org?.defaultAgentId ?? null } : null;
  });
  const memberContext = createExecutionMemberContext(scope);
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
  const connectorContext = createConnectorContextGroups(userId, orgId, agentId);
  const { permissionGrants$, workflows$ } = connectorContext;
  const officialCatalog$ = reusedOfficialCatalog(supplied);
  const officialWorkflows$ = computed(async (get) => {
    const workflows = await get(workflows$);
    return hasSelectedOfficialWorkflow(workflows)
      ? await get(
          createOfficialWorkflowFacts(workflows, await get(officialCatalog$)),
        )
      : null;
  });
  const storage$ = computed(async (get): Promise<AgentStorageContext> => {
    const plan = agentStorageReadPlan(
      scope,
      await Promise.all([
        get(agent$),
        get(workflows$),
        get(connectorContext.connectorSelection$),
        get(connectorContext.catalog$),
        get(officialWorkflows$),
      ]),
    );
    return captureAgentStorageContext(
      plan,
      await readStorageBaseIndex(get(db$), plan.ownedRequests),
    );
  });
  const storageCache$ = computed(async (get) => {
    return agentStorageCacheSnapshot(await get(storage$));
  });
  const disabledPaidTools$ =
    sharedMember?.disabledPaidTools$ ?? memberContext.disabledPaidTools$;
  const featureSwitchContext$ =
    sharedMember?.featureSwitches$ ??
    computed(async (get): Promise<BootstrapFeatureSwitchContext> => {
      const [member, overrides] = await Promise.all([
        get(memberMetadata$),
        get(memberContext.overrides$),
      ]);
      return capturedFeatureSwitchContext(scope, member, overrides);
    });
  const environment$ = computed(async (get) => {
    requirePreparedContextAgent(await get(agent$));
    const snapshot = await get(connectorContext.environmentSnapshot$);
    return { variables: snapshot.variables };
  });
  const context: OwnedAgentRunContext = {
    [globalModelOwner]: globalReferences.catalog$,
    ...scope,
    agent$,
    orgRows$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    allowance$,
    credits$,
    modelFacts$,
    memberModels$,
    ...modelSources,
    memberMetadata$,
    connectorSelection$: connectorContext.connectorSelection$,
    permissionGrants$,
    workflows$,
    officialCatalog$,
    officialWorkflows$,
    storage$,
    storageCache$,
    featureSwitches$: featureSwitchContext$,
    disabledPaidTools$,
    environment$,
    customConnectorDefinitions$: connectorContext.customConnectorDefinitions$,
    catalog$: connectorContext.catalog$,
    connectors$: connectorContext.connectors$,
  };
  return context;
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
      signals.connectors$,
      signals.storage$,
      signals.agent$,
      signals.orgRows$,
      signals.orgMetadata$,
      signals.plan$,
      signals.concurrencyCapacity$,
      signals.allowance$,
      signals.credits$,
      signals.modelFacts$,
      signals.memberModels$,
      signals.orgModelSources$,
      signals.gatewayModelSources$,
      signals.memberMetadata$,
      signals.connectorSelection$,
      signals.permissionGrants$,
      signals.workflows$,
      signals.officialWorkflows$,
      signals.storageCache$,
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

/** Own decryption only after the run's eager plan selects captured values. */
export function createEagerConnectorCredentialContext(
  credentials: readonly {
    readonly id: string;
    readonly encryptedValue: string;
  }[],
  resolveStartedAt: number,
): EagerConnectorCredentialContext {
  const credentials$ = computed(async () => {
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

const bootstrapVariablesDecoder = zodDriverValueDecoder(
  z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      userId: z.string(),
      connectorId: z.string().nullable(),
    }),
  ),
);
const bootstrapConnectorVariablesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.string()),
);
const bootstrapCredentialsDecoder = zodDriverValueDecoder(
  z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      encryptedValue: z.string(),
    }),
  ),
);

type BootstrapEnvironmentSnapshot =
  ReturnType<typeof createAgentEnvironment> extends Computed<Promise<infer T>>
    ? T
    : never;

function createAgentEnvironment(userId: string, orgId: string) {
  return computed(async (get) => {
    const db = get(db$);
    const variableRows = bootstrapVariableRows(userId, orgId);
    const variableSnapshot = bootstrapVariableSnapshot(variableRows);
    const connectorVariableSnapshot =
      bootstrapConnectorVariableSnapshot(variableRows);
    const credentialSnapshot = bootstrapCredentialSnapshot(userId, orgId);
    // A single statement owns the account revision and its credential values.
    // It also supplies Agent variables, including the empty-account case.
    const statement = db
      .with(
        variableRows,
        variableSnapshot,
        connectorVariableSnapshot,
        credentialSnapshot,
      )
      .select({
        account: {
          id: connectors.id,
          connectorSlug: connectors.connectorSlug,
          customConnectorId: connectors.customConnectorId,
          isDefault: connectors.isDefault,
          automaticAuthType: connectors.automaticAuthType,
          connectorStateRevision:
            sql`(EXTRACT(EPOCH FROM ${connectors.updatedAt}) * 1000000)::bigint`.mapWith(
              pgInt8ToBigIntDecoder,
            ),
          needsReconnect: connectors.needsReconnect,
          authMethod: connectors.authMethod,
          storageVersion: connectors.storageVersion,
          tokenExpiresAt: connectors.tokenExpiresAt,
          updatedAt: connectors.updatedAt,
          orgId: connectors.orgId,
          userId: connectors.userId,
        },
        variableValues: variableSnapshot.values,
        connectorVariables: connectorVariableSnapshot.values,
        credentials: credentialSnapshot.values,
        automaticOAuthBindingId:
          customConnectorAccountOauthBindings.connectorAccountId,
      })
      .from(variableSnapshot)
      .leftJoin(
        connectors,
        and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)),
      )
      .leftJoin(
        connectorVariableSnapshot,
        eq(connectorVariableSnapshot.connectorId, connectors.id),
      )
      .leftJoin(
        credentialSnapshot,
        eq(credentialSnapshot.connectorId, connectors.id),
      )
      .leftJoin(
        customConnectorAccountOauthBindings,
        and(
          eq(
            customConnectorAccountOauthBindings.connectorAccountId,
            connectors.id,
          ),
          eq(
            customConnectorAccountOauthBindings.customConnectorId,
            connectors.customConnectorId,
          ),
        ),
      );
    const acquisitionCapture: PgPoolAcquisitionCapture = { acquisitions: [] };
    const queryStartedAt = performance.now();
    const rows = await withPgPoolAcquisitionCapture(
      acquisitionCapture,
      async () => {
        return await statement;
      },
    );
    const query = connectorContextDuration(queryStartedAt);
    const materializeStartedAt = performance.now();
    const [first] = rows;
    if (!first) {
      throw new Error("Bootstrap environment aggregate returned no row");
    }
    const snapshot = {
      variables: first.variableValues ?? [],
      accounts: rows.flatMap((row) => {
        return row.account
          ? [
              {
                ...row.account,
                automaticOAuthBindingId: row.automaticOAuthBindingId,
              },
            ]
          : [];
      }),
      values: {
        variables: rows.flatMap((row) => {
          const account = row.account;
          return account
            ? Object.entries(row.connectorVariables ?? {}).map(
                ([name, value]) => {
                  return { sourceId: account.id, name, value };
                },
              )
            : [];
        }),
        credentials: rows.flatMap((row) => {
          const account = row.account;
          return account
            ? (row.credentials ?? []).map((credential) => {
                return { ...credential, sourceId: account.id };
              })
            : [];
        }),
      },
    };
    const materialize = connectorContextDuration(materializeStartedAt);
    return {
      ...snapshot,
      observation: bootstrapEnvironmentObservation({
        query,
        materialize,
        acquisitions: acquisitionCapture.acquisitions,
        returnedRowCount: rows.length,
        accounts: snapshot.accounts,
        storedValueCount:
          snapshot.values.variables.length + snapshot.values.credentials.length,
      }),
    };
  });
}

function bootstrapVariableRows(userId: string, orgId: string) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_variables").as(
    db
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
        connectorId: variables.connectorId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgId),
          or(
            and(
              eq(variables.type, "user"),
              or(
                eq(variables.userId, ORG_SENTINEL_USER_ID),
                eq(variables.userId, userId),
              ),
            ),
            and(eq(variables.type, "connector"), eq(variables.userId, userId)),
          ),
        ),
      ),
  );
}

function bootstrapVariableSnapshot(
  rows: ReturnType<typeof bootstrapVariableRows>,
) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_user_variables").as(
    db
      .select({
        values: sql`jsonb_agg(jsonb_build_object(
        'name', ${rows.name}, 'value', ${rows.value},
        'userId', ${rows.userId}, 'connectorId', ${rows.connectorId}
      ))`
          .mapWith(nullableDriverValueDecoder(bootstrapVariablesDecoder))
          .as("user_variable_values"),
      })
      .from(rows)
      .where(isNull(rows.connectorId)),
  );
}

function bootstrapConnectorVariableSnapshot(
  rows: ReturnType<typeof bootstrapVariableRows>,
) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_connector_variables").as(
    db
      .select({
        connectorId: rows.connectorId,
        values: sql`jsonb_object_agg(${rows.name}, ${rows.value})`
          .mapWith(
            nullableDriverValueDecoder(bootstrapConnectorVariablesDecoder),
          )
          .as("connector_variable_values"),
      })
      .from(rows)
      .where(isNotNull(rows.connectorId))
      .groupBy(rows.connectorId),
  );
}

function bootstrapCredentialSnapshot(userId: string, orgId: string) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_credentials").as(
    db
      .select({
        connectorId: secrets.connectorId,
        values: sql`jsonb_agg(jsonb_build_object(
          'id', ${secrets.id}, 'name', ${secrets.name}, 'encryptedValue', ${secrets.encryptedValue}
        ))`
          .mapWith(nullableDriverValueDecoder(bootstrapCredentialsDecoder))
          .as("credential_values"),
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "connector"),
        ),
      )
      .groupBy(secrets.connectorId),
  );
}

/** Connector groups share one account/environment statement and one catalog capture. */
function createConnectorContextGroups(
  userId: string,
  orgId: string,
  agentId: string,
) {
  const { connectorSelection$, permissionGrants$, workflows$ } =
    createAgentSelectionContext({
      userId,
      orgId,
      agentId,
    });
  const environmentSnapshot$ = createAgentEnvironment(userId, orgId);
  const customConnectorDefinitions$ = computed(async (get) => {
    return (await get(connectorSelection$)).customConnectorDefinitions;
  });
  const connectorSnapshot$ = computed(async (get) => {
    const [snapshot, definitions] = await Promise.all([
      get(environmentSnapshot$),
      get(customConnectorDefinitions$),
    ]);
    return bootstrapConnectorSnapshot(userId, orgId, snapshot, definitions);
  });
  const requested$ = computed(async (get) => {
    const selection = await get(connectorSelection$);
    const scope = agentConnectorScopeFromRows({
      connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
        return { connectorSlug };
      }),
      customConnectorRows: selection.customConnectors,
    });
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
  const connectors$ = computed(async (get): Promise<BootstrapConnectorData> => {
    const snapshot = await get(connectorSnapshot$);
    return {
      connectorAccounts: snapshot.accounts,
      connectorSources: snapshot.sources,
      observation: snapshot.observation,
    };
  });
  return {
    connectorSelection$,
    permissionGrants$,
    workflows$,
    environmentSnapshot$,
    customConnectorDefinitions$,
    catalog$,
    connectors$,
  };
}
