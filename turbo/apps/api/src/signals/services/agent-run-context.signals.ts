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
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { secrets } from "@okouai/db/schema/secret";
import { command, computed, type Computed } from "ccstate";
import { performance } from "node:perf_hooks";
import { array, object, record, string, unknown as zUnknown } from "zod";
import { pgInt8ToBigIntSchema } from "../../lib/db-raw-rows";
import {
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisition,
  type PgPoolAcquisitionCapture,
} from "../../lib/db-instrumentation";
import {
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { waitUntil } from "../context/wait-until";
import { safeSync, settle } from "../utils";
import type { BootstrapAgent } from "./agent-data.service";
import {
  createMemberMemoryContext,
  type MemberMemoryContext,
} from "./agent-storage-context.service";
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
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";

import { createConnectorRuntimeSelection } from "./connector-catalog-entries.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import { buildAgentRunVariables } from "./agent-run-variables";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import {
  createAuthorizedConnectors,
  type AuthorizedConnectors,
} from "./authorized-connectors.service";
import type { ConnectorExecutionRuntimeSelection } from "./connector-catalog-runtime.service";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";
import type { ExecutionConnectorSelection } from "./execution-connector-selection";
import type { ConnectorMember } from "./member-connector-selection";
import {
  memberConnectorContextColumns,
  createExecutionConnectorContext,
} from "./execution-connector-context";
import type { ConnectorPermissionGrant } from "./execution-connector-permissions.service";
import {
  contextJsonProjection,
  contextJsonRows,
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
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

import { now, nowDate } from "../../lib/time";
import { createThreadConnectorSources } from "./thread-connector-sources.service";
import {
  executionCreditBalance,
  type ExecutionCreditBalance,
} from "./execution-credit-balance.service";
import {
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { createRunTemplateSources } from "./run-template-sources.service";

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

type RunContextAgent = BootstrapAgent &
  Pick<typeof agents.$inferSelect, "instructionsBundle">;

/** The only cross-graph read-only signal interface; no state or commands. */
export interface AgentRunContextSignals {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly agent$: Computed<Promise<RunContextAgent | null>>;
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
  /** Existing Thread preferences can start before its input is enqueued. */
  readonly requestThreadConnectorIdentity$: Parameters<
    typeof createThreadConnectorSources
  >[0];
  readonly requestThreadConnectorSources$: ReturnType<
    typeof createThreadConnectorSources
  >;
  /** Request candidate rows are consumed only by this exact picked input. */
  readonly requestTemplateInputId$: Computed<Promise<string | undefined>>;
  readonly requestTemplateSources$: ReturnType<typeof createRunTemplateSources>;
  readonly memberConnectorSelection$: Computed<
    Promise<ExecutionConnectorSelection>
  >;
  /** The member's connector permission grants, expanded into firewall policies. */
  readonly permissionPolicies$: Computed<Promise<FirewallPolicies | null>>;
  readonly runVariables$: Computed<Promise<Record<string, string>>>;
  readonly authorizedConnectors$: Computed<Promise<AuthorizedConnectors>>;
  readonly permissionGrants$: Computed<
    Promise<readonly ConnectorPermissionGrant[]>
  >;
  /** Seed Skill rows read with the model catalog; shared across contexts. */
  readonly seedSkills$: ReturnType<
    typeof createGlobalModelContext
  >["seedSkills$"];
  readonly memory$: Computed<Promise<MemberMemoryContext>>;
  readonly featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>;
  readonly disabledPaidTools$: Computed<Promise<readonly PaidToolId[]>>;
  readonly environment$: Computed<Promise<BootstrapEnvironment>>;
  readonly customConnectorDefinitions$: Computed<
    Promise<readonly CustomConnectorExecutionDefinition[]>
  >;
  readonly catalog$: Computed<
    Promise<ConnectorExecutionRuntimeSelection | null>
  >;
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

function catalogMetadataSlugs(selection: ExecutionConnectorSelection) {
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
  requestInputs?: {
    readonly inputId: string;
    readonly chatThreadId?: string;
    readonly presentationIds: readonly string[];
    readonly userTemplateIds: readonly string[];
  },
): AgentRunContextSignals {
  return createIdentityContext(
    userId,
    orgId,
    agentId,
    undefined,
    requestInputs,
  );
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
    instructionsBundle: agents.instructionsBundle,
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

function createRequestInputSources(
  scope: ConnectorMember & { readonly agentId: string },
  requestInputs: Parameters<typeof createAgentRunContextSignals>[3],
) {
  const requestThreadConnectorIdentity$ = computed(() => {
    const chatThreadId = requestInputs?.chatThreadId;
    return Promise.resolve(
      chatThreadId === undefined ? null : { ...scope, chatThreadId },
    );
  });
  const requestThreadConnectorSources$ = createThreadConnectorSources(
    requestThreadConnectorIdentity$,
  );
  const requestTemplateInputId$ = computed(() => {
    return Promise.resolve(requestInputs?.inputId);
  });
  const requestTemplateSources$ = createRunTemplateSources(
    computed(() => {
      return Promise.resolve(
        requestInputs ? { ...scope, ...requestInputs } : null,
      );
    }),
  );
  return {
    requestThreadConnectorIdentity$,
    requestThreadConnectorSources$,
    requestTemplateInputId$,
    requestTemplateSources$,
  };
}

function createIdentityContext(
  userId: string,
  orgId: string,
  agentId: string,
  supplied?: AgentRunContextSignals,
  requestInputs?: Parameters<typeof createAgentRunContextSignals>[3],
): OwnedAgentRunContext {
  const scope = { userId, orgId, agentId };
  const requestSources = createRequestInputSources(scope, requestInputs);
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
  const agent$ = computed(async (get): Promise<RunContextAgent | null> => {
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
  const connectorContext = createConnectorContextGroups(userId, orgId, agentId);
  const memory$ = createMemberMemoryContext(scope);
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
    ...requestSources,
    selectedImageModel$:
      sharedMember?.selectedImageModel$ ??
      createSelectedImageModel(memberMetadata$),
    ...connectorContext.signals,
    seedSkills$: globalReferences.seedSkills$,
    memory$,
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
      signals.requestThreadConnectorSources$,
      signals.catalog$,
      signals.authorizedConnectors$,
      signals.connectors$,
      signals.requestTemplateSources$,
      signals.memory$,
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
      signals.memberConnectorSelection$,
      signals.permissionGrants$,
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

const bootstrapVariablesDecoder = zodDriverValueDecoder(
  array(
    object({
      name: string(),
      value: string(),
      userId: string(),
      connectorId: string().nullable(),
    }),
  ),
);
const bootstrapConnectorVariablesDecoder = zodDriverValueDecoder(
  record(string(), string()),
);
const bootstrapCredentialsDecoder = zodDriverValueDecoder(
  array(
    object({
      id: string(),
      name: string(),
    }),
  ),
);

const bootstrapConnectorAccountColumns = Object.freeze({
  id: connectors.id,
  connectorSlug: connectors.connectorSlug,
  customConnectorId: connectors.customConnectorId,
  isDefault: connectors.isDefault,
  defaultEnabledForChats: connectors.defaultEnabledForChats,
  createdAt: connectors.createdAt,
  automaticAuthType: connectors.automaticAuthType,
  needsReconnect: connectors.needsReconnect,
  authMethod: connectors.authMethod,
  storageVersion: connectors.storageVersion,
  tokenExpiresAt: connectors.tokenExpiresAt,
  updatedAt: connectors.updatedAt,
  orgId: connectors.orgId,
  userId: connectors.userId,
});

type BootstrapEnvironmentSnapshot =
  ReturnType<typeof createAgentEnvironment> extends Computed<Promise<infer T>>
    ? T
    : never;

const bootstrapAccountRowsDecoder = zodDriverValueDecoder(
  array(
    object({
      account: contextProjectionSchema(bootstrapConnectorAccountColumns).and(
        object({
          connectorStateRevision: pgInt8ToBigIntSchema,
        }),
      ),
      connectorVariables: record(string(), string()).nullable(),
      credentials: array(object({ id: string(), name: string() })).nullable(),
      automaticOAuthBindingId: string().nullable(),
    }),
  ),
);

function bootstrapConnectorAccountRows(
  userId: string,
  orgId: string,
  connectorVariableSnapshot: ReturnType<
    typeof bootstrapConnectorVariableSnapshot
  >,
  credentialSnapshot: ReturnType<typeof bootstrapCredentialSnapshot>,
) {
  return new QueryBuilder()
    .select({
      payload: sql`jsonb_build_object(
        'account', ${contextJsonProjection(bootstrapConnectorAccountColumns)} || jsonb_build_object(
          'connectorStateRevision', (EXTRACT(EPOCH FROM ${connectors.updatedAt}) * 1000000)::bigint::text
        ),
        'connectorVariables', ${connectorVariableSnapshot.values},
        'credentials', ${credentialSnapshot.values},
        'automaticOAuthBindingId', ${customConnectorAccountOauthBindings.connectorAccountId}
      )`
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(connectors)
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
    )
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));
}

/** Related accounts, definitions, bindings, values and grants share one observation. */
function createAgentEnvironment(member: ConnectorMember) {
  return computed(async (get) => {
    const { userId, orgId } = member;
    const db = get(db$);
    const variableRows = bootstrapVariableRows(userId, orgId);
    const variableSnapshot = bootstrapVariableSnapshot(variableRows);
    const connectorVariableSnapshot =
      bootstrapConnectorVariableSnapshot(variableRows);
    const credentialSnapshot = bootstrapCredentialSnapshot(userId, orgId);
    const accountRows = bootstrapConnectorAccountRows(
      userId,
      orgId,
      connectorVariableSnapshot,
      credentialSnapshot,
    );
    // Scalar rowsets keep the envelope at one row, without multiplying selection
    // or permission payloads by the member's number of accounts.
    const statement = db
      .with(
        variableRows,
        variableSnapshot,
        connectorVariableSnapshot,
        credentialSnapshot,
      )
      .select({
        variableValues: variableSnapshot.values,
        accountRows: contextJsonRows(accountRows).mapWith(
          bootstrapAccountRowsDecoder,
        ),
        ...memberConnectorContextColumns(member, nowDate()),
      })
      .from(variableSnapshot);
    const acquisitionCapture: PgPoolAcquisitionCapture = { acquisitions: [] };
    const queryStartedAt = performance.now();
    const resultRows = await withPgPoolAcquisitionCapture(
      acquisitionCapture,
      async () => {
        return await statement;
      },
    );
    const query = connectorContextDuration(queryStartedAt);
    const materializeStartedAt = performance.now();
    const [first] = resultRows;
    if (!first) {
      throw new Error("Bootstrap environment aggregate returned no row");
    }
    const rows = first.accountRows;
    const snapshot = {
      variables: first.variableValues ?? [],
      accounts: rows.map((row) => {
        return {
          ...row.account,
          automaticOAuthBindingId: row.automaticOAuthBindingId,
        };
      }),
      values: {
        variables: rows.flatMap((row) => {
          return Object.entries(row.connectorVariables ?? {}).map(
            ([name, value]) => {
              return { sourceId: row.account.id, name, value };
            },
          );
        }),
        credentials: rows.flatMap((row) => {
          return (row.credentials ?? []).map((credential) => {
            return { ...credential, sourceId: row.account.id };
          });
        }),
      },
    };
    const materialize = connectorContextDuration(materializeStartedAt);
    return {
      ...snapshot,
      builtin: first.builtin,
      custom: first.custom,
      permissions: first.permissions,
      observation: bootstrapEnvironmentObservation({
        query,
        materialize,
        acquisitions: acquisitionCapture.acquisitions,
        returnedRowCount: resultRows.length,
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
          'id', ${secrets.id}, 'name', ${secrets.name}
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
  const sources = createConnectorSources({ userId, orgId });
  const runVariables$ = computed(async (get) => {
    const snapshot = await get(sources.environmentSnapshot$);
    return buildAgentRunVariables({ agentId, variables: snapshot.variables });
  });
  return {
    environmentSnapshot$: sources.environmentSnapshot$,
    signals: {
      ...sources.signals,
      runVariables$,
    },
  };
}

function createConnectorSources(member: ConnectorMember) {
  const environmentSnapshot$ = createAgentEnvironment(member);
  const { connectorSelection$, permissionGrants$ } =
    createExecutionConnectorContext(environmentSnapshot$);
  const customConnectorDefinitions$ = computed(async (get) => {
    return (await get(connectorSelection$)).customConnectorDefinitions;
  });
  const connectorSnapshot$ = computed(async (get) => {
    const { userId, orgId } = member;
    const [snapshot, definitions] = await Promise.all([
      get(environmentSnapshot$),
      get(customConnectorDefinitions$),
    ]);
    return bootstrapConnectorSnapshot(userId, orgId, snapshot, definitions);
  });
  const requested$ = computed(async (get) => {
    const selection = await get(connectorSelection$);
    const { scope } = selection;
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
  const permissionPolicies$ = computed(async (get) => {
    const [grants, { scope }, catalog] = await Promise.all([
      get(permissionGrants$),
      get(connectorSelection$),
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
      memberConnectorSelection$: connectorSelection$,
      authorizedConnectors$,
      permissionGrants$,
      customConnectorDefinitions$,
      catalog$,
      connectors$,
      permissionPolicies$,
    },
  };
}
