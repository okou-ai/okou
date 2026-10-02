import { computed, type Computed } from "ccstate";
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
import {
  createBootstrapAgent,
  type BootstrapAgent,
} from "./agent-data.service";

import {
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  countConnectorCatalogRuntimeProjectionRows,
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
import { and, asc, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { db$, type ReadonlyDb } from "../external/db";
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
  readonly catalog: ConnectorRuntimeSelection | null;
  readonly connectorAccounts: readonly BootstrapConnectorAccount[];
  readonly connectorSources: readonly ConnectorSourceResult[];
  readonly decryptedConnectorCredentials: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof settle<string>>>
  >;
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
  const environmentSnapshot$ = createAgentEnvironment(userId, orgId);
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
  const customConnectorDefinitions$ = computed(async (get) => {
    return (await get(connectorSelection$)).customConnectorDefinitions;
  });
  const connectorSnapshot$ = createBootstrapConnectorSnapshot(
    userId,
    orgId,
    environmentSnapshot$,
    customConnectorDefinitions$,
  );
  const catalog$ = createBootstrapCatalog(connectorSelection$);
  const decryptedCredentials$ = createBootstrapDecryptedCredentials(
    connectorSnapshot$,
    catalog$,
  );
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
      connectorSnapshot,
      decryptedConnectorCredentials,
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
      get(connectorSnapshot$),
      get(decryptedCredentials$),
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
      connectorAccounts: connectorSnapshot.accounts,
      connectorSources: connectorSnapshot.sources,
      decryptedConnectorCredentials,
    };
  });
}

function createBootstrapConnectorSnapshot(
  userId: string,
  orgId: string,
  environmentSnapshot$: ReturnType<typeof createAgentEnvironment>,
  customConnectorDefinitions$: Computed<
    Promise<readonly CustomConnectorExecutionDefinition[]>
  >,
) {
  return computed(async (get) => {
    const [snapshot, definitions] = await Promise.all([
      get(environmentSnapshot$),
      get(customConnectorDefinitions$),
    ]);
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
  });
}

function createBootstrapDecryptedCredentials(
  connectorSnapshot$: ReturnType<typeof createBootstrapConnectorSnapshot>,
  catalog$: ReturnType<typeof createBootstrapCatalog>,
) {
  return computed(async (get) => {
    const [{ sources }, catalog] = await Promise.all([
      get(connectorSnapshot$),
      get(catalog$),
    ]);
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
    return new Map(decrypted);
  });
}

function createBootstrapCatalog(
  connectorSelection$: ReturnType<typeof createAgentConnectorSelection>,
) {
  const identity$ = createAgentCatalogIdentity();
  return computed(async (get): Promise<ConnectorRuntimeSelection | null> => {
    const selection = await get(connectorSelection$);
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
    if (
      scope.allowedConnectorSlugs.length === 0 &&
      scope.allowedCustomConnectorIds.length === 0
    ) {
      return null;
    }
    const captured = await get(identity$);
    // Reuse the existing accepted-catalog cache for fallback bytes. A valid
    // projection remains authoritative even when those bytes are malformed.
    const accepted = await settle(bootstrapAcceptedCatalog(captured));
    const requested = {
      runtimeConnectorSlugs: scope.allowedConnectorSlugs,
      metadataConnectorSlugs: metadataSlugs,
    };
    if (captured.projection.kind === "ready") {
      const projection = captured.projection.projection;
      const { cached, uncachedSlugs } = takeCachedProjectedConnectors(
        projection.identity,
        connectorSlugs,
      );
      const rows = await get(
        createAgentCatalogProjectionRows(
          projection.identity.projectionSetId,
          uncachedSlugs,
        ),
      );
      const validated = validateConnectorCatalogRuntimeProjectionRows({
        rows,
        connectorSlugs: uncachedSlugs,
      });
      if (validated.kind === "ready") {
        const complete =
          validated.missingConnectorSlugs.length === 0 ||
          (await countConnectorCatalogRuntimeProjectionRows({
            db: get(db$),
            identity: projection.identity,
          })) === projection.identity.connectorCount;
        if (complete) {
          rememberProjectedConnectors(
            projection.identity,
            validated.connectors,
          );
          return materializeProjectedRuntimeSelection({
            projection,
            connectors: [...cached, ...validated.connectors],
            ...requested,
          });
        }
      }
    }
    if (!accepted.ok) {
      throw accepted.error;
    }
    return runtimeSelectionFromAcceptedSnapshot({
      acceptedSnapshot: accepted.value,
      ...requested,
    });
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

function createAgentEnvironment(userId: string, orgId: string) {
  return computed(async (get) => {
    const db = get(db$);
    const variableRows = bootstrapVariableRows(db, userId, orgId);
    const variableSnapshot = bootstrapVariableSnapshot(db, variableRows);
    const connectorVariableSnapshot = bootstrapConnectorVariableSnapshot(
      db,
      variableRows,
    );
    const credentialSnapshot = bootstrapCredentialSnapshot(db, userId, orgId);
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

function bootstrapVariableRows(db: ReadonlyDb, userId: string, orgId: string) {
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
  db: ReadonlyDb,
  rows: ReturnType<typeof bootstrapVariableRows>,
) {
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
  db: ReadonlyDb,
  rows: ReturnType<typeof bootstrapVariableRows>,
) {
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

function bootstrapCredentialSnapshot(
  db: ReadonlyDb,
  userId: string,
  orgId: string,
) {
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
