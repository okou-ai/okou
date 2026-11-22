import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
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
import { createExecutionPackageSources } from "./execution-package-sources";
import { createExecutionOrgMemberContext } from "./execution-org-member-context.signals";
import type { ExecutionMemberMetadata } from "./execution-member-metadata.service";
import {
  type ExecutionOrgRows,
  executionExpiredCredits,
  executionOrgMetadata,
  executionOrgPlan,
  executionOrgSlots,
} from "./execution-org-context.service";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

import { now, nowDate } from "../../lib/time";
import { threadConnectorSourcesColumn } from "./thread-connector-sources.service";
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
  readonly personalExecution: boolean;
  readonly userId: string;
  readonly orgId: string;
  readonly email?: string;
  readonly overrides: Partial<Record<FeatureSwitchKey, boolean>>;
}

type ChatRunContextIdentity = Pick<
  AgentRunContextSignals,
  "userId" | "orgId" | "chatThreadId"
>;

/** The only cross-graph read-only signal interface; no state or commands. */
export interface AgentRunContextSignals {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly executionPackageSources$: ReturnType<
    typeof createExecutionPackageSources
  >;
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
  readonly threadConnectorSources$: Computed<
    Promise<BootstrapEnvironmentSnapshot["threadSources"]>
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
  readonly featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>;
  readonly disabledPaidTools$: Computed<Promise<readonly PaidToolId[]>>;
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
  readonly externalEmail: string | null;
  readonly displayName: string | null;
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

interface RunContextRequestInputs {
  readonly inputId: string;
  readonly newThread: boolean;
  readonly requireVisibleThread?: boolean;
  readonly presentationIds: readonly string[];
  readonly userTemplateIds: readonly string[];
}

/** Compose the authoritative read definitions once per execution identity. */
export function createAgentRunContextSignals(
  identity: ChatRunContextIdentity,
  requestInputs: RunContextRequestInputs,
) {
  const scope = {
    ...identity,
    chatThreadId: identity.chatThreadId.toLowerCase(),
  };
  const memberContext = createExecutionOrgMemberContext(
    scope,
    true,
    requestInputs.newThread ? undefined : scope.chatThreadId,
    requestInputs.requireVisibleThread,
  );
  return {
    context: createIdentityContext(
      scope,
      undefined,
      requestInputs,
      memberContext,
    ),
    existingThread$: memberContext.existingThread$,
  };
}

/** Reuse by each group's authority key before wiring dependent computeds. */
export function matchAgentRunContextSignals(
  supplied: AgentRunContextSignals | undefined,
  identity: ChatRunContextIdentity,
): AgentRunContextSignals {
  const { userId, orgId } = identity;
  const chatThreadId = identity.chatThreadId.toLowerCase();
  if (
    supplied?.orgId === orgId &&
    supplied.userId === userId &&
    supplied.chatThreadId === chatThreadId
  ) {
    return supplied;
  }
  return createIdentityContext({ userId, orgId, chatThreadId }, supplied);
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

function capturedFeatureSwitchContext(
  scope: { readonly orgId: string; readonly userId: string },
  member: ExecutionMemberMetadata,
  overrides: BootstrapFeatureSwitchContext["overrides"],
): BootstrapFeatureSwitchContext {
  return {
    userId: scope.userId,
    orgId: scope.orgId,
    email: member.profile?.email ?? undefined,
    overrides,
    personalExecution: true,
  };
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
  supplied?: AgentRunContextSignals,
  memberContext = createExecutionOrgMemberContext(
    { userId, orgId },
    supplied?.orgId !== orgId,
  ),
) {
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
  scope: ConnectorMember,
  requestInputs: RunContextRequestInputs | undefined,
  sharedMember: AgentRunContextSignals | undefined,
) {
  if (sharedMember) {
    return {
      requestTemplateInputId$: sharedMember.requestTemplateInputId$,
      requestTemplateSources$: sharedMember.requestTemplateSources$,
    };
  }
  const requestTemplateInputId$ = computed(() => {
    return Promise.resolve(requestInputs?.inputId);
  });
  const requestTemplateSources$ = createRunTemplateSources(
    computed(() => {
      return Promise.resolve(
        requestInputs
          ? {
              userId: scope.userId,
              orgId: scope.orgId,
              presentationIds: requestInputs.presentationIds,
              userTemplateIds: requestInputs.userTemplateIds,
            }
          : null,
      );
    }),
  );
  return {
    requestTemplateInputId$,
    requestTemplateSources$,
  };
}

function createIdentityContext(
  scope: ChatRunContextIdentity,
  supplied?: AgentRunContextSignals,
  requestInputs?: RunContextRequestInputs,
  preparedMemberContext?: ReturnType<typeof createExecutionOrgMemberContext>,
): OwnedAgentRunContext {
  const { userId, orgId } = scope;
  const {
    memberContext,
    orgRows$,
    orgMetadata$,
    plan$,
    concurrencyCapacity$,
    modelFacts$,
    globalReferences,
    memberModels$,
    modelSources,
  } = createOrgContext(orgId, userId, supplied, preparedMemberContext);
  const sharedMember =
    supplied?.orgId === orgId && supplied.userId === userId
      ? supplied
      : undefined;
  const requestSources = createRequestInputSources(
    scope,
    requestInputs,
    sharedMember,
  );
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
  const featureSwitchContext$ = sharedMember
    ? sharedMember.featureSwitches$
    : computed(async (get): Promise<BootstrapFeatureSwitchContext> => {
        const [member, overrides] = await Promise.all([
          get(memberMetadata$),
          get(memberContext.overrides$),
        ]);
        return capturedFeatureSwitchContext(scope, member, overrides);
      });
  const connectorContext = createConnectorContext(
    scope,
    requestInputs?.newThread ?? false,
  );
  const disabledPaidTools$ =
    sharedMember?.disabledPaidTools$ ?? memberContext.disabledPaidTools$;
  return {
    [globalModelOwner]: globalReferences.catalog$,
    ...scope,
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
    executionPackageSources$:
      sharedMember?.executionPackageSources$ ??
      createExecutionPackageSources(scope),
    selectedImageModel$:
      sharedMember?.selectedImageModel$ ??
      createSelectedImageModel(memberMetadata$),
    ...connectorContext,
    seedSkills$: globalReferences.seedSkills$,
    featureSwitches$: featureSwitchContext$,
    disabledPaidTools$,
  };
}

/**
 * Trigger the launch groups during send preparation or once a pick has capacity.
 * Cached failures remain authoritative.
 */
export const preloadAgentRunContext$ = command(
  ({ get }, signals: AgentRunContextSignals, signal: AbortSignal): void => {
    signal.throwIfAborted();
    // Start the org/member and global model reads before launch-only prefetches.
    // Normal sends have already captured the organization/member and Chat row.
    // All nodes start in this turn; the starter awaits none of them.
    const nodes: readonly Computed<Promise<unknown>>[] = [
      signals.modelFacts$,
      signals.catalog$,
      signals.authorizedConnectors$,
      signals.connectors$,
      signals.requestTemplateSources$,
      signals.orgRows$,
      signals.orgMetadata$,
      signals.plan$,
      signals.concurrencyCapacity$,
      signals.credits$,
      signals.modelCatalog$,
      signals.memberModels$,
      signals.memberRoutes$,
      signals.memberMetadata$,
      signals.selectedImageModel$,
      signals.featureSwitches$,
      signals.disabledPaidTools$,
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
  externalEmail: connectors.externalEmail,
  displayName: connectors.displayName,
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

/** Accounts, definitions, bindings, values, grants and Chat settings share one observation. */
function createAgentEnvironment(
  member: ChatRunContextIdentity,
  newThread: boolean,
) {
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
        threadSources: threadConnectorSourcesColumn(member, newThread),
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
      threadSources: first.threadSources,
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

/** Connector groups share one environment statement and one catalog capture. */
function createConnectorContext(
  member: ChatRunContextIdentity,
  newThread: boolean,
) {
  const environmentSnapshot$ = createAgentEnvironment(member, newThread);
  const threadConnectorSources$ = computed(async (get) => {
    return (await get(environmentSnapshot$)).threadSources;
  });
  const runVariables$ = computed(async (get) => {
    const snapshot = await get(environmentSnapshot$);
    return buildAgentRunVariables({ variables: snapshot.variables });
  });
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
    threadConnectorSources$,
    runVariables$,
    memberConnectorSelection$: connectorSelection$,
    authorizedConnectors$,
    permissionGrants$,
    customConnectorDefinitions$,
    catalog$,
    connectors$,
    permissionPolicies$,
  };
}
