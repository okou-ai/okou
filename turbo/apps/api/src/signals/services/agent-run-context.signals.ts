import { command, computed, type Computed } from "ccstate";
import { waitUntil } from "../context/wait-until";
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
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { z } from "zod";
import {
  pgInt8ToBigIntDecoder,
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { mapConcurrent } from "../../lib/map-concurrent";
import { settle } from "../utils";
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
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  validateConnectorCatalogRuntimeProjectionRows,
  type CapturedAgentCatalog,
} from "./connector-catalog-runtime-projection.service";
import {
  requestedProjectionConnectorSlugs,
  materializeProjectedRuntimeSelection,
  runtimeSelectionFromAcceptedSnapshot,
  takeCachedProjectedConnectors,
  rememberProjectedConnectors,
  type ConnectorRuntimeSelection,
  getConnectorRuntimeConnector,
  getConnectorRuntimeMethod,
} from "./connector-catalog-runtime.service";
import { connectorAuthMethodOwnedSecretNames } from "@okouai/connectors/connector-auth-method";
import {
  decodeAcceptedConnectorCatalogPayload,
  readCachedConnectorCatalogSnapshot,
  ExternalConnectorCatalogUnavailableError,
} from "./connector-catalog-external-reader.service";
import { connectorCatalogExecutableCapabilityState } from "./connector-catalog-compatibility.service";
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
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { variables } from "@okouai/db/schema/variable";
import { and, asc, count, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { connectorCatalogRuntimeProjections } from "@okouai/db/schema/connector-catalog";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

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
  readonly catalog$: Computed<Promise<ConnectorRuntimeSelection | null>>;
  readonly connectors$: Computed<Promise<BootstrapConnectorData>>;
}

export interface BootstrapConnectorData {
  readonly connectorAccounts: readonly BootstrapConnectorAccount[];
  readonly connectorSources: readonly ConnectorSourceResult[];
  readonly decryptedConnectorCredentials: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof settle<string>>>
  >;
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
  const {
    connectorSelection$,
    environmentSnapshot$,
    customConnectorDefinitions$,
    catalog$,
    connectors$,
  } = createConnectorContextGroups(userId, orgId, agentId);
  const permissionGrants$ = createConnectorPermissionGrants(scope);
  const workflows$ = createAgentWorkflowSelection(scope);
  const featureSwitchOverrides$ = userFeatureSwitchOverrides(orgId, userId);
  const disabledPaidTools$ = createAgentDisabledPaidTools(userId, orgId);
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
    const snapshot = await get(environmentSnapshot$);
    return { variables: snapshot.variables };
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
    connectors$,
  };
}

/** Trigger each group after enqueue; cached failures remain authoritative. */
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
      signals.connectors$,
    ];
    for (const node of nodes) {
      waitUntil(settle(get(node)));
    }
  },
);

function requiredProjectionCount(
  row: { readonly value: number } | undefined,
): number {
  if (!row) {
    throw new Error("Connector runtime projection count query returned no row");
  }
  return row.value;
}

function bootstrapConnectorSnapshot(
  userId: string,
  orgId: string,
  snapshot: BootstrapEnvironmentSnapshot,
  definitions: readonly CustomConnectorExecutionDefinition[],
) {
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
  return {
    accounts,
    sources: connectorSourceSnapshotsFromRows(
      { userId, orgId, sources },
      accounts,
      snapshot.values,
    ),
  };
}

async function bootstrapDecryptedCredentials(
  snapshot: ReturnType<typeof bootstrapConnectorSnapshot>,
  catalog: ConnectorRuntimeSelection | null,
) {
  const { sources } = snapshot;
  const credentials = sources.flatMap((source) => {
    if (
      source.kind !== "available" ||
      source.snapshot.source.kind !== "builtin" ||
      !catalog
    ) {
      return [];
    }
    const connectorSlug = source.snapshot.source.connectorSlug;
    const connector = getConnectorRuntimeConnector(catalog, connectorSlug);
    if (!connector || connector.catalogConnector.mcp) {
      return [];
    }
    const method = getConnectorRuntimeMethod({
      snapshot: catalog,
      connectorSlug,
      authMethodId: source.snapshot.connection.authMethod,
    });
    if (!method?.executable) {
      return [];
    }
    const names = new Set(connectorAuthMethodOwnedSecretNames(method.method));
    return source.snapshot.credentials.filter((credential) => {
      return names.has(credential.name);
    });
  });
  // An unused account's malformed credential must not fail another account's
  // run. Preserve each result; only the selected, catalog-owned names consume it.
  const decrypted = await mapConcurrent(credentials, 4, async (credential) => {
    return [
      credential.id,
      await settle(decryptStoredSecretValue(credential.encryptedValue)),
    ] as const;
  });
  return new Map(decrypted);
}

function bootstrapCatalogRequest(selection: AgentConnectorSelection) {
  const scope = agentConnectorScopeFromRows({
    connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
      return { connectorSlug };
    }),
    customConnectorRows: selection.customConnectors,
  });
  return scope.allowedConnectorSlugs.length === 0 &&
    scope.allowedCustomConnectorIds.length === 0
    ? null
    : {
        runtimeConnectorSlugs: scope.allowedConnectorSlugs,
        metadataConnectorSlugs: catalogMetadataSlugs(selection),
      };
}

type BootstrapProjection = {
  readonly projection: Extract<
    CapturedAgentCatalog["projection"],
    { kind: "ready" }
  >["projection"];
  readonly cached: readonly ConnectorCatalogArtifactConnector[];
  readonly validated: ReturnType<
    typeof validateConnectorCatalogRuntimeProjectionRows
  >;
  readonly actualCount: number | undefined;
};

async function bootstrapCatalogSelection(
  input: {
    readonly captured: CapturedAgentCatalog;
    readonly requested: NonNullable<ReturnType<typeof bootstrapCatalogRequest>>;
  },
  projected: BootstrapProjection | null,
): Promise<ConnectorRuntimeSelection> {
  // Only the fallback consumes its error: valid projected rows can execute even
  // if the same generation's fallback bytes are malformed.
  const accepted = await settle(bootstrapAcceptedCatalog(input.captured));
  if (
    projected?.validated.kind === "ready" &&
    (projected.validated.missingConnectorSlugs.length === 0 ||
      projected.actualCount === projected.projection.identity.connectorCount)
  ) {
    rememberProjectedConnectors(
      projected.projection.identity,
      projected.validated.connectors,
    );
    return materializeProjectedRuntimeSelection({
      projection: projected.projection,
      connectors: [...projected.cached, ...projected.validated.connectors],
      ...input.requested,
    });
  }
  if (!accepted.ok) {
    throw accepted.error;
  }
  return runtimeSelectionFromAcceptedSnapshot({
    acceptedSnapshot: accepted.value,
    ...input.requested,
  });
}

async function bootstrapAcceptedCatalog(captured: CapturedAgentCatalog) {
  if (captured.snapshot) {
    return captured.snapshot;
  }
  if (!captured.identity || !captured.payload) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  const identity = captured.identity;
  const payload = captured.payload;
  const snapshot = await readCachedConnectorCatalogSnapshot({
    identity,
    timing: undefined,
    load: () => {
      return Promise.resolve(
        decodeAcceptedConnectorCatalogPayload({
          identity,
          capability: connectorCatalogExecutableCapabilityState(),
          row: payload,
        }),
      );
    },
  });
  if (!snapshot) {
    throw new ExternalConnectorCatalogUnavailableError(
      "captured_identity_unavailable",
    );
  }
  return snapshot;
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
    const rows = await db
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
    const [first] = rows;
    if (!first) {
      throw new Error("Bootstrap environment aggregate returned no row");
    }
    return {
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

/** Connector groups share one account/environment statement and one catalog capture. */
function createConnectorContextGroups(
  userId: string,
  orgId: string,
  agentId: string,
) {
  const connectorSelection$ = createAgentConnectorSelection({
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
  const catalogIdentity$ = createAgentCatalogIdentity();
  const catalogRequest$ = computed(async (get) => {
    return bootstrapCatalogRequest(await get(connectorSelection$));
  });
  const catalogCapture$ = computed(async (get) => {
    const requested = await get(catalogRequest$);
    return requested
      ? { requested, captured: await get(catalogIdentity$) }
      : null;
  });
  const catalogProjection$ = computed(async (get) => {
    const input = await get(catalogCapture$);
    if (!input || input.captured.projection.kind !== "ready") {
      return null;
    }
    const projection = input.captured.projection.projection;
    const cached = takeCachedProjectedConnectors(
      projection.identity,
      requestedProjectionConnectorSlugs(input.requested),
    );
    const rows = await get(
      createAgentCatalogProjectionRows(
        projection.identity.projectionSetId,
        cached.uncachedSlugs,
      ),
    );
    const validated = validateConnectorCatalogRuntimeProjectionRows({
      rows,
      connectorSlugs: cached.uncachedSlugs,
    });
    const actualCount =
      validated.kind === "ready" && validated.missingConnectorSlugs.length > 0
        ? requiredProjectionCount(
            (
              await get(db$)
                .select({ value: count() })
                .from(connectorCatalogRuntimeProjections)
                .where(
                  eq(
                    connectorCatalogRuntimeProjections.projectionSetId,
                    projection.identity.projectionSetId,
                  ),
                )
            )[0],
          )
        : undefined;
    return { projection, cached: cached.cached, validated, actualCount };
  });
  const catalog$ = computed(
    async (get): Promise<ConnectorRuntimeSelection | null> => {
      const input = await get(catalogCapture$);
      return input
        ? await bootstrapCatalogSelection(input, await get(catalogProjection$))
        : null;
    },
  );
  const decryptedCredentials$ = computed(async (get) => {
    const [snapshot, catalog] = await Promise.all([
      get(connectorSnapshot$),
      get(catalog$),
    ]);
    return await bootstrapDecryptedCredentials(snapshot, catalog);
  });
  const connectors$ = computed(async (get): Promise<BootstrapConnectorData> => {
    const [snapshot, decryptedConnectorCredentials] = await Promise.all([
      get(connectorSnapshot$),
      get(decryptedCredentials$),
    ]);
    return {
      connectorAccounts: snapshot.accounts,
      connectorSources: snapshot.sources,
      decryptedConnectorCredentials,
    };
  });
  return {
    connectorSelection$,
    environmentSnapshot$,
    customConnectorDefinitions$,
    catalog$,
    connectors$,
  };
}
