import {
  deviceAuthSessionPublicationSql,
  type DeviceAuthSessionPublication,
} from "./model-provider-device-session-publication";
import { randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import {
  getAuthMethodsForType,
  getFrameworkForType,
  getModelProviderPresentationLabel,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  getSecretsForAuthMethod,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  modelProviderTypeSchema,
  type ModelProviderFramework,
  type ModelProviderType,
  type ModelProviderWriteType,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getDefaultModel,
  type ModelProviderEnvBindings,
  getModelProviderCodexRuntimeConfig,
  getModelProviderCodexRuntimeCapabilities,
  getModelProviderCodexCatalogForModel,
  type ModelProviderCodexRuntimeConfig,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type FeatureSwitchContext,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { modelProviders as modelProvidersTable } from "@okouai/db/schema/model-provider";
import { modelProviderConnections } from "@okouai/db/schema/model-provider-gateway";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import {
  publishModelPoliciesChangedForOrgSafely,
  publishPersonalModelProvidersChangedSafely,
} from "../external/realtime";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import {
  encryptStoredSecretValue,
  decryptStoredSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

import {
  disconnectPersonalModelProviderAccounts$,
  isPersonalSubscriptionProviderType,
  upsertPersonalModelProviderAccount$,
  type UpsertPersonalAccountArgs,
  visiblePersonalModelProviderCondition,
} from "./model-provider-account.service";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  type BuiltInModelRuntimeRoute,
  isBuiltInModelRuntimeRoutePermitted,
} from "./built-in-model-runtime-route.service";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  type ModelCatalog,
  catalogProviderUpstreamModel,
  catalogHasProviderRoute,
} from "./model-catalog.service";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  OPENROUTER_US_ORIGIN,
  getOpenRouterBaseUrl,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import {
  compileModelRuntime,
  type ModelCredentialValues,
} from "./execution-model-runtime";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { SupportedFramework } from "@okouai/core/frameworks";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import { providerTypeForSurfaceProtocol } from "./effective-model-route.service";
import {
  GATEWAY_RUNTIME_SECRET_NAME,
  compileModelProviderGatewayRuntime,
} from "./model-provider-gateway-runtime";

const L = logger("model-provider.service");

const ORG_SENTINEL_USER_ID = "__org__";
type ModelProviderRow = typeof modelProvidersTable.$inferSelect;

function publishProviderChanged(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  return args.userId === ORG_SENTINEL_USER_ID
    ? publishModelPoliciesChangedForOrgSafely(args.orgId)
    : publishPersonalModelProvidersChangedSafely(args.userId);
}

function hasUsableSecretValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function modelProviderResponse(row: {
  readonly id: string;
  readonly type: string;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly authMethod: string | null;
  readonly secretName: string | null;
  readonly workspaceName: string | null;
  readonly planType: string | null;
  readonly subscriptionResetPeriod: string | null;
  readonly subscriptionNextResetAt: Date | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ModelProviderResponse | null {
  const parsed = modelProviderTypeSchema.safeParse(row.type);
  if (!parsed.success) {
    return null;
  }

  const authMethod = row.authMethod ?? null;
  const type = parsed.data;
  return {
    id: row.id,
    type,
    framework: getFrameworkForType(type),
    secretName: row.secretName,
    authMethod,
    secretNames: authMethod
      ? (getSecretNamesForAuthMethod(parsed.data, authMethod) ?? null)
      : null,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    workspaceName: row.workspaceName,
    planType: row.planType,
    subscriptionResetPeriod: row.subscriptionResetPeriod,
    subscriptionNextResetAt: row.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function modelProvidersForUser(
  orgId: string,
  ownerUserId: string,
): Computed<Promise<ModelProviderListResponse>> {
  return computed(async (get): Promise<ModelProviderListResponse> => {
    const rows = await get(db$)
      .select({
        id: modelProvidersTable.id,
        type: modelProvidersTable.type,
        isDefault: modelProvidersTable.isDefault,
        selectedModel: modelProvidersTable.selectedModel,
        authMethod: modelProvidersTable.authMethod,
        secretName: secrets.name,
        workspaceName: modelProvidersTable.workspaceName,
        planType: modelProvidersTable.planType,
        subscriptionResetPeriod: modelProvidersTable.subscriptionResetPeriod,
        subscriptionNextResetAt: modelProvidersTable.subscriptionNextResetAt,
        needsReconnect: modelProvidersTable.needsReconnect,
        lastRefreshErrorCode: modelProvidersTable.lastRefreshErrorCode,
        createdAt: modelProvidersTable.createdAt,
        updatedAt: modelProvidersTable.updatedAt,
      })
      .from(modelProvidersTable)
      .leftJoin(secrets, eq(modelProvidersTable.secretId, secrets.id))
      .where(
        and(
          eq(modelProvidersTable.orgId, orgId),
          eq(modelProvidersTable.userId, ownerUserId),
        ),
      )
      .orderBy(modelProvidersTable.type);

    return {
      modelProviders: rows.flatMap((row) => {
        const provider = modelProviderResponse(row);
        return provider ? [provider] : [];
      }),
    };
  });
}

export function modelProviders(
  orgId: string,
): Computed<Promise<ModelProviderListResponse>> {
  return modelProvidersForUser(orgId, ORG_SENTINEL_USER_ID);
}

type NotFoundResponse = ReturnType<typeof notFound>;

/**
 * Delete a user-level model provider and cascade-delete its secrets.
 *
 * Delete behavior: a conditional DELETE of the provider row decides the
 * result, then its secrets go in the same short transaction.
 *   - Legacy single-secret providers: an unshared secret is deleted with the
 *     row (the FK cascade also removes any other provider sharing it). During
 *     gateway migration, a shared secret is retained.
 *   - Multi-auth providers: deletes every auth method's secrets by name, so a
 *     leftover from a replaced auth method cannot survive the provider.
 *
 * A concurrent refresh publishes through an exact provider-row CAS, so it
 * cannot recreate secrets after the row is gone.
 */
export const deleteUserModelProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderType;
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | ReturnType<typeof conflict> | undefined> => {
    const writeDb = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (
      args.userId !== ORG_SENTINEL_USER_ID &&
      isPersonalSubscriptionProviderType(args.type)
    ) {
      return await set(
        disconnectPersonalModelProviderAccounts$,
        {
          orgId: args.orgId,
          userId: args.userId,
          selection: { kind: "provider", type: args.type },
          featureSwitchContext,
        },
        signal,
      );
    }

    const result = await writeDb.transaction(async (tx) => {
      // Provider configuration is low frequency; no compatibility or
      // concurrent-operation lock is retained.
      signal.throwIfAborted();

      // The conditional delete is the decision: zero rows means another
      // writer already removed it. Its implicit row lock precedes every secret
      // write, the same order every provider writer and refresh CAS use.
      const [provider] = await tx
        .delete(modelProvidersTable)
        .where(
          and(
            eq(modelProvidersTable.orgId, args.orgId),
            eq(modelProvidersTable.userId, args.userId),
            eq(modelProvidersTable.type, args.type),
          ),
        )
        .returning({
          secretId: modelProvidersTable.secretId,
        });
      signal.throwIfAborted();

      if (!provider) {
        return notFound("Resource not found");
      }

      if (provider.secretId) {
        // During gateway migration a shared secret is retained; otherwise the
        // legacy single secret goes with its provider.
        const [gatewayReference] = await tx
          .select({ id: modelProviderConnections.id })
          .from(modelProviderConnections)
          .where(eq(modelProviderConnections.secretId, provider.secretId))
          .limit(1);
        if (!gatewayReference) {
          await tx.delete(secrets).where(eq(secrets.id, provider.secretId));
        }
        signal.throwIfAborted();
      } else {
        const secretNames = allMultiAuthSecretNames(args.type);
        if (secretNames.length > 0) {
          await tx
            .delete(secrets)
            .where(
              and(
                eq(secrets.orgId, args.orgId),
                eq(secrets.userId, args.userId),
                eq(secrets.type, "model-provider"),
                isNull(secrets.connectorId),
                inArray(secrets.name, secretNames),
              ),
            );
          signal.throwIfAborted();
        }
      }

      return undefined;
    });
    signal.throwIfAborted();
    if (result === undefined) {
      await publishProviderChanged(args);
      signal.throwIfAborted();
    }
    return result;
  },
);

export const deleteOrgModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderType;
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | ReturnType<typeof conflict> | undefined> => {
    return await set(
      deleteUserModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
      },
      signal,
    );
  },
);

// ===========================================================================
// Upsert path for API model-provider routes.
//
// Shared upsert path for API org and personal model-provider routes. Returns
// either a `BadRequestResponse` or `{ provider, created }`.
// ===========================================================================

type BadRequestResponse = ReturnType<typeof badRequestMessage>;

/**
 * Row shape returned to the route handler. The codex paste handler's
 * `UpsertedProvider` remains a structural subset of this shape.
 */
export interface ModelProviderInfo {
  readonly id: string;
  readonly userId: string;
  readonly type: ModelProviderType;
  readonly framework: ModelProviderFramework;
  readonly secretName: string | null;
  readonly authMethod: string | null;
  readonly secretNames: string[] | null;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly workspaceName: string | null;
  readonly planType: string | null;
  readonly subscriptionResetPeriod: string | null;
  readonly subscriptionNextResetAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toModelProviderInfo(params: {
  id: string;
  userId: string;
  type: ModelProviderType;
  secretName?: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  tokenExpiresAt?: Date | null;
  needsReconnect?: boolean;
  lastRefreshErrorCode?: string | null;
  workspaceName?: string | null;
  planType?: string | null;
  subscriptionResetPeriod?: string | null;
  subscriptionNextResetAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ModelProviderInfo {
  const type = params.type;
  const authMethod = params.authMethod ?? null;
  const secretNames =
    params.secretNames !== undefined
      ? params.secretNames
      : authMethod
        ? (getSecretNamesForAuthMethod(params.type, authMethod) ?? null)
        : null;

  return {
    id: params.id,
    userId: params.userId,
    type,
    framework: getFrameworkForType(type),
    secretName: params.secretName ?? null,
    authMethod,
    secretNames,
    isDefault: params.isDefault,
    selectedModel: params.selectedModel,
    tokenExpiresAt: params.tokenExpiresAt ?? null,
    needsReconnect: params.needsReconnect ?? false,
    lastRefreshErrorCode: params.lastRefreshErrorCode ?? null,
    workspaceName: params.workspaceName ?? null,
    planType: params.planType ?? null,
    subscriptionResetPeriod: params.subscriptionResetPeriod ?? null,
    subscriptionNextResetAt: params.subscriptionNextResetAt ?? null,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

function toModelProviderInfoFromRow(args: {
  readonly provider: ModelProviderRow;
  readonly userId: string;
  readonly type: ModelProviderType;
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
  readonly secretNames?: string[] | null;
}): ModelProviderInfo {
  const { provider } = args;
  return toModelProviderInfo({
    id: provider.id,
    userId: args.userId,
    type: args.type,
    secretName: args.secretName,
    authMethod: args.authMethod,
    secretNames: args.secretNames,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    tokenExpiresAt: provider.tokenExpiresAt,
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
    workspaceName: provider.workspaceName,
    planType: provider.planType,
    subscriptionResetPeriod: provider.subscriptionResetPeriod,
    subscriptionNextResetAt: provider.subscriptionNextResetAt,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  });
}

/**
 * Reject the built-in provider on personal-tier callers — it is org-only per
 * Epic #11868.
 * Returns BadRequestResponse so the route handler emits 400 without throwing.
 */
function assertBuiltInOrgOnly(
  type: ModelProviderWriteType,
  userId: string,
): BadRequestResponse | null {
  if (type === "built-in" && userId !== ORG_SENTINEL_USER_ID) {
    return badRequestMessage(
      `${getModelProviderPresentationLabel(type)} provider is org-only and cannot be configured per-user`,
    );
  }
  return null;
}

function validateSingleSecretProviderRequest(args: {
  readonly type: ModelProviderWriteType;
  readonly secret: string;
}): BadRequestResponse | { readonly secretName: string } {
  const secretName = getSecretNameForType(args.type);
  if (!secretName) {
    return badRequestMessage(
      `Provider "${args.type}" does not have a secret name`,
    );
  }
  if (!hasUsableSecretValue(args.secret)) {
    return badRequestMessage(
      `Provider "${args.type}" requires a non-empty secret`,
    );
  }
  return { secretName };
}

/**
 * Every secret name any auth method of a multi-auth type can own. Multi-auth
 * secret names are unique to their provider type, so deleting them by name
 * cannot touch another provider's credentials.
 */
function allMultiAuthSecretNames(type: ModelProviderType): string[] {
  const names = new Set<string>();
  for (const authMethod of Object.keys(getAuthMethodsForType(type) ?? {})) {
    for (const name of getSecretNamesForAuthMethod(type, authMethod) ?? []) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * `xmax = 0` on an upserted row means this statement inserted it; the ON
 * CONFLICT update path stamps the row with this transaction's xid.
 */
const upsertInsertedColumn = sql`(${modelProvidersTable}.xmax = 0)`.mapWith(
  pgBooleanDecoder,
);

interface ModelProviderMetadata {
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

interface EncryptedMultiAuthSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

type MultiAuthInsertValues = typeof modelProvidersTable.$inferInsert;

function buildMultiAuthInsertValues(args: {
  type: ModelProviderWriteType;
  userId: string;
  authMethod: string;
  selectedModel: string | undefined;
  orgId: string;
  metadata: ModelProviderMetadata | undefined;
}): MultiAuthInsertValues {
  return {
    type: args.type,
    userId: args.userId,
    authMethod: args.authMethod,
    isDefault: false,
    selectedModel: args.selectedModel ?? null,
    orgId: args.orgId,
    tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
    workspaceName: args.metadata?.workspaceName ?? null,
    planType: args.metadata?.planType ?? null,
    subscriptionResetPeriod: args.metadata?.subscriptionResetPeriod ?? null,
    subscriptionNextResetAt: args.metadata?.subscriptionNextResetAt ?? null,
  };
}

function buildMultiAuthConflictSet(
  authMethod: string,
  selectedModel: string | undefined,
  preserveSelectedModel: boolean,
  metadata?: ModelProviderMetadata,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    authMethod,
    updatedAt: sql`clock_timestamp()`,
  };
  // Omitting the column keeps the existing row's value on conflict.
  if (selectedModel !== undefined || !preserveSelectedModel) {
    base.selectedModel = selectedModel ?? null;
  }
  if (!metadata) {
    return base;
  }
  if (metadata.tokenExpiresAt !== undefined) {
    base.tokenExpiresAt = metadata.tokenExpiresAt;
  }
  if (metadata.workspaceName !== undefined) {
    base.workspaceName = metadata.workspaceName;
  }
  if (metadata.planType !== undefined) {
    base.planType = metadata.planType;
  }
  if (metadata.subscriptionResetPeriod !== undefined) {
    base.subscriptionResetPeriod = metadata.subscriptionResetPeriod;
  }
  if (metadata.subscriptionNextResetAt !== undefined) {
    base.subscriptionNextResetAt = metadata.subscriptionNextResetAt;
  }
  base.needsReconnect = false;
  base.lastRefreshErrorCode = null;
  return base;
}

function buildSingleAuthConflictSet(args: {
  readonly selectedModel: string | undefined;
  readonly metadata?: ModelProviderMetadata;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    selectedModel: args.selectedModel ?? null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    updatedAt: nowDate(),
  };
  if (!args.metadata) {
    return base;
  }
  if (args.metadata.tokenExpiresAt !== undefined) {
    base.tokenExpiresAt = args.metadata.tokenExpiresAt;
  }
  if (args.metadata.workspaceName !== undefined) {
    base.workspaceName = args.metadata.workspaceName;
  }
  if (args.metadata.planType !== undefined) {
    base.planType = args.metadata.planType;
  }
  if (args.metadata.subscriptionResetPeriod !== undefined) {
    base.subscriptionResetPeriod = args.metadata.subscriptionResetPeriod;
  }
  if (args.metadata.subscriptionNextResetAt !== undefined) {
    base.subscriptionNextResetAt = args.metadata.subscriptionNextResetAt;
  }
  return base;
}

const persistSingleAuthModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderWriteType;
      readonly secretName: string;
      readonly encryptedValue: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly provider: ModelProviderRow;
    readonly created: boolean;
  }> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      // The provider row is written first: its implicit row lock orders this
      // writer before its secret, the same order delete and the refresh CAS
      // use. A new row starts without its secret and is completed below.
      const [upsertedProvider] = await tx
        .insert(modelProvidersTable)
        .values({
          type: args.type,
          userId: args.userId,
          secretId: null,
          isDefault: false,
          selectedModel: args.selectedModel ?? null,
          orgId: args.orgId,
          tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
          workspaceName: args.metadata?.workspaceName ?? null,
          planType: args.metadata?.planType ?? null,
          subscriptionResetPeriod:
            args.metadata?.subscriptionResetPeriod ?? null,
          subscriptionNextResetAt:
            args.metadata?.subscriptionNextResetAt ?? null,
        })
        .onConflictDoUpdate({
          target: [
            modelProvidersTable.orgId,
            modelProvidersTable.userId,
            modelProvidersTable.type,
          ],
          set: buildSingleAuthConflictSet({
            selectedModel: args.selectedModel,
            metadata: args.metadata,
          }),
        })
        .returning({
          ...getTableColumns(modelProvidersTable),
          inserted: upsertInsertedColumn,
        });
      signal.throwIfAborted();
      if (!upsertedProvider) {
        throw new Error("Expected model provider upsert to return a row");
      }

      const [upsertedSecret] = await tx
        .insert(secrets)
        .values({
          userId: args.userId,
          name: args.secretName,
          encryptedValue: args.encryptedValue,
          type: "model-provider",
          description: `Model provider secret for ${MODEL_PROVIDER_TYPES[args.type].label}`,
          orgId: args.orgId,
        })
        .onConflictDoUpdate({
          target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
          targetWhere: isNull(secrets.connectorId),
          set: { encryptedValue: args.encryptedValue, updatedAt: nowDate() },
        })
        .returning({ id: secrets.id });
      signal.throwIfAborted();

      if (!upsertedSecret) {
        throw new Error("Expected secret upsert to return a row");
      }

      const { inserted, ...upsertedRow } = upsertedProvider;
      let provider: ModelProviderRow = upsertedRow;
      if (upsertedRow.secretId !== upsertedSecret.id) {
        // This transaction already holds the row, so the update cannot miss.
        const [linked] = await tx
          .update(modelProvidersTable)
          .set({ secretId: upsertedSecret.id })
          .where(eq(modelProvidersTable.id, upsertedRow.id))
          .returning();
        signal.throwIfAborted();
        if (!linked) {
          throw new Error(
            "Expected model provider secret link to return a row",
          );
        }
        provider = linked;
      }

      const consent = deviceAuthSessionPublicationSql(args);
      if (consent && (await tx.execute(consent)).rowCount !== 1) {
        throw new Error("Device authorization was cancelled or expired");
      }
      return { provider, created: inserted };
    });
    signal.throwIfAborted();
    return result;
  },
);

/**
 * Create or update a single-secret personal model provider.
 */
export const upsertUserModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderWriteType;
      readonly secret: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const builtIn = assertBuiltInOrgOnly(args.type, args.userId);
    if (builtIn) {
      return builtIn;
    }

    if (hasAuthMethods(args.type)) {
      return badRequestMessage(
        `Provider "${args.type}" requires multiple secrets. Use the multi-auth API instead.`,
      );
    }

    const validation = validateSingleSecretProviderRequest(args);
    if ("status" in validation) {
      return validation;
    }
    const { secretName } = validation;

    if (
      args.userId !== ORG_SENTINEL_USER_ID &&
      isPersonalSubscriptionProviderType(args.type)
    ) {
      return await set(
        upsertSingletonSubscription$,
        {
          ...args,
          type: args.type,
          authMethod: null,
          secretValues: { [secretName]: args.secret },
        },
        signal,
      );
    }
    const encryptedValue = await encryptStoredSecretValue(args.secret);
    signal.throwIfAborted();

    L.debug("upserting model provider", {
      orgId: args.orgId,
      type: args.type,
      secretName,
    });

    const result = await set(
      persistSingleAuthModelProvider$,
      { ...args, secretName, encryptedValue },
      signal,
    );
    signal.throwIfAborted();

    await publishProviderChanged(args);
    signal.throwIfAborted();

    return {
      provider: toModelProviderInfoFromRow({
        provider: result.provider,
        userId: args.userId,
        type: args.type,
        secretName,
      }),
      created: result.created,
    };
  },
);

async function encryptMultiAuthSecrets(
  args: {
    readonly type: ModelProviderWriteType;
    readonly authMethod: string;
    readonly secretValues: Record<string, string>;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<readonly EncryptedMultiAuthSecret[]> {
  const description = `${MODEL_PROVIDER_TYPES[args.type].label} secret (${args.authMethod})`;
  const encryptedSecrets: EncryptedMultiAuthSecret[] = [];
  for (const [name, value] of Object.entries(args.secretValues)) {
    const encryptedValue = await encryptStoredSecretValue(
      value,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    encryptedSecrets.push({ name, encryptedValue, description });
  }
  return encryptedSecrets;
}

const persistMultiAuthModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderWriteType;
      readonly authMethod: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
      readonly secretNames: readonly string[];
      readonly encryptedSecrets: readonly EncryptedMultiAuthSecret[];
    },
    signal: AbortSignal,
  ): Promise<{
    readonly provider: ModelProviderRow;
    readonly wasCreated: boolean;
  }> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      // Existing provider uniqueness handles first-save insertion.
      signal.throwIfAborted();

      // Upsert the provider row first. Its implicit row (or unique-index)
      // lock makes concurrent saves, including two first saves with
      // different auth methods, apply one after another; the later one sees
      // the earlier one's committed secrets below and removes them.
      const [upsertedProvider] = await tx
        .insert(modelProvidersTable)
        .values(
          buildMultiAuthInsertValues({
            ...args,
            selectedModel: args.selectedModel,
            metadata: args.metadata,
          }),
        )
        .onConflictDoUpdate({
          target: [
            modelProvidersTable.orgId,
            modelProvidersTable.userId,
            modelProvidersTable.type,
          ],
          set: buildMultiAuthConflictSet(
            args.authMethod,
            args.selectedModel,
            args.type === "azure-foundry" || args.type === "aws-bedrock",
            args.metadata,
          ),
        })
        .returning({
          ...getTableColumns(modelProvidersTable),
          inserted: upsertInsertedColumn,
        });
      signal.throwIfAborted();
      if (!upsertedProvider) {
        throw new Error(
          "Expected multi-auth model provider upsert to return a row",
        );
      }
      const { inserted, ...provider } = upsertedProvider;

      const obsoleteNames = allMultiAuthSecretNames(args.type).filter(
        (name) => {
          return !args.secretNames.includes(name);
        },
      );
      if (obsoleteNames.length > 0) {
        await tx
          .delete(secrets)
          .where(
            and(
              eq(secrets.orgId, args.orgId),
              eq(secrets.userId, args.userId),
              eq(secrets.type, "model-provider"),
              isNull(secrets.connectorId),
              inArray(secrets.name, obsoleteNames),
            ),
          );
        signal.throwIfAborted();
      }
      for (const secret of args.encryptedSecrets) {
        await tx
          .insert(secrets)
          .values({
            orgId: args.orgId,
            userId: args.userId,
            type: "model-provider",
            ...secret,
          })
          .onConflictDoUpdate({
            target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
            targetWhere: isNull(secrets.connectorId),
            set: {
              encryptedValue: secret.encryptedValue,
              description: secret.description,
              updatedAt: nowDate(),
            },
          });
        signal.throwIfAborted();
      }
      const consent = deviceAuthSessionPublicationSql(args);
      if (consent && (await tx.execute(consent)).rowCount !== 1) {
        throw new Error("Device authorization was cancelled or expired");
      }
      return { provider, wasCreated: inserted };
    });
    signal.throwIfAborted();
    return result;
  },
);

/**
 * Validate the multi-auth upsert input shape (auth method exists, required
 * secrets present, etc.). Returns a BadRequestResponse if any check fails;
 * otherwise null. Extracted from `upsertUserMultiAuthModelProvider$` so the
 * Command body stays under the per-function lint ceiling.
 */
function validateMultiAuthUpsertInput(args: {
  readonly type: ModelProviderWriteType;
  readonly authMethod: string;
  readonly secretValues: Record<string, string>;
}): BadRequestResponse | null {
  if (!hasAuthMethods(args.type)) {
    return badRequestMessage(
      `Provider "${args.type}" is a legacy single-secret provider. Use the standard upsert API.`,
    );
  }

  const authMethods = getAuthMethodsForType(args.type);
  if (!authMethods || !(args.authMethod in authMethods)) {
    const validMethods = authMethods ? Object.keys(authMethods).join(", ") : "";
    return badRequestMessage(
      `Invalid auth method "${args.authMethod}" for provider "${args.type}". Valid methods: ${validMethods}`,
    );
  }

  const secretsConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretsConfig) {
    return badRequestMessage(
      `No secrets config found for auth method "${args.authMethod}"`,
    );
  }

  const unknownNames = Object.keys(args.secretValues).filter((name) => {
    return !Object.hasOwn(secretsConfig, name);
  });
  if (unknownNames.length > 0) {
    return badRequestMessage(
      `Unsupported secrets for ${args.authMethod}: ${unknownNames.join(", ")}`,
    );
  }

  const missingRequired: string[] = [];
  for (const [name, config] of Object.entries(secretsConfig)) {
    if (config.required && !hasUsableSecretValue(args.secretValues[name])) {
      missingRequired.push(name);
    }
  }
  if (missingRequired.length > 0) {
    return badRequestMessage(
      `Missing required secrets for ${args.authMethod}: ${missingRequired.join(", ")}`,
    );
  }

  return null;
}

/**
 * Create or update a multi-auth personal model provider (e.g., aws-bedrock,
 * codex-oauth-token).
 */
export const upsertUserMultiAuthModelProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderWriteType;
      readonly authMethod: string;
      readonly secretValues: Record<string, string>;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const validationError = validateMultiAuthUpsertInput({
      type: args.type,
      authMethod: args.authMethod,
      secretValues: args.secretValues,
    });
    if (validationError) {
      return validationError;
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    if (
      args.userId !== ORG_SENTINEL_USER_ID &&
      isPersonalSubscriptionProviderType(args.type)
    ) {
      return await set(
        upsertSingletonSubscription$,
        { ...args, type: args.type },
        signal,
      );
    }
    const secretNames = Object.keys(args.secretValues);
    const encryptedSecrets = await encryptMultiAuthSecrets(
      { ...args, featureSwitchContext },
      signal,
    );

    L.debug("upserting multi-auth model provider", {
      orgId: args.orgId,
      type: args.type,
      authMethod: args.authMethod,
      secretNames,
    });

    const result = await set(
      persistMultiAuthModelProvider$,
      {
        ...args,
        secretNames,
        encryptedSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    const { provider } = result;
    await publishProviderChanged(args);
    signal.throwIfAborted();

    return {
      provider: toModelProviderInfoFromRow({
        provider,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        secretNames,
      }),
      created: result.wasCreated,
    };
  },
);

export const upsertOrgModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderWriteType;
      readonly secret: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      upsertUserModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
        secret: args.secret,
        selectedModel: args.selectedModel,
        metadata: args.metadata,
        authSession: args.authSession,
      },
      signal,
    );
  },
);

export const upsertOrgMultiAuthModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderWriteType;
      readonly authMethod: string;
      readonly secretValues: Record<string, string>;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
      readonly authSession?: DeviceAuthSessionPublication;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      upsertUserMultiAuthModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
        authMethod: args.authMethod,
        secretValues: args.secretValues,
        selectedModel: args.selectedModel,
        metadata: args.metadata,
        authSession: args.authSession,
      },
      signal,
    );
  },
);

export const upsertOrgNoSecretModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderWriteType;
      readonly selectedModel?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const builtIn = assertBuiltInOrgOnly(args.type, ORG_SENTINEL_USER_ID);
    if (builtIn) {
      return builtIn;
    }
    if (args.type !== "built-in") {
      return badRequestMessage(`Provider "${args.type}" requires a secret`);
    }

    const writeDb = set(writeDb$);

    L.debug("upserting org no-secret model provider", {
      orgId: args.orgId,
      type: args.type,
      selectedModel: args.selectedModel,
    });

    const proposedId = randomUUID();
    const [provider] = await writeDb
      .insert(modelProvidersTable)
      .values({
        id: proposedId,
        type: "built-in",
        userId: ORG_SENTINEL_USER_ID,
        isDefault: false,
        selectedModel: args.selectedModel ?? null,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [
          modelProvidersTable.orgId,
          modelProvidersTable.userId,
          modelProvidersTable.type,
        ],
        set: {
          selectedModel: args.selectedModel ?? null,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();
    if (!provider) {
      throw new Error("Expected no-secret model provider upsert to return row");
    }

    await publishModelPoliciesChangedForOrgSafely(args.orgId);
    signal.throwIfAborted();
    return {
      provider: toModelProviderInfoFromRow({
        provider,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
      }),
      created: provider.id === proposedId,
    };
  },
);

const upsertSingletonSubscription$ = command(
  async (
    { get, set },
    args: Omit<UpsertPersonalAccountArgs, "mode" | "featureSwitchContext">,
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const [previous] = await db
      .select({ id: modelProvidersTable.id })
      .from(modelProvidersTable)
      .where(
        and(
          eq(modelProvidersTable.orgId, args.orgId),
          eq(modelProvidersTable.userId, args.userId),
          eq(modelProvidersTable.type, args.type),
          visiblePersonalModelProviderCondition(),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const result = await set(
      upsertPersonalModelProviderAccount$,
      { ...args, featureSwitchContext, mode: { kind: "replace-active" } },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in result) {
      return badRequestMessage(result.body.error.message);
    }
    if (!result.provider.modelProviderId) {
      throw new Error("Concrete subscription account has no logical provider");
    }
    const [provider] = await db
      .select()
      .from(modelProvidersTable)
      .where(eq(modelProvidersTable.id, result.provider.modelProviderId))
      .limit(1);
    signal.throwIfAborted();
    if (!provider) {
      throw new Error("Subscription provider disappeared after connection");
    }
    // Personal subscription state lives only on the connected account; the
    // logical provider row keeps the singleton ID, default and model selection.
    const [account] = await db
      .select()
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.id, result.provider.id))
      .limit(1);
    signal.throwIfAborted();
    if (!account) {
      throw new Error("Subscription account disappeared after connection");
    }
    return {
      created: !previous,
      provider: toModelProviderInfo({
        id: provider.id,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        secretName: getSecretNameForType(args.type) ?? null,
        secretNames: args.authMethod
          ? (getSecretNamesForAuthMethod(args.type, args.authMethod) ?? null)
          : null,
        isDefault: provider.isDefault,
        selectedModel: provider.selectedModel,
        tokenExpiresAt: account.tokenExpiresAt,
        needsReconnect: account.needsReconnect,
        lastRefreshErrorCode: account.lastRefreshErrorCode,
        workspaceName: account.workspaceName,
        planType: account.planType,
        subscriptionResetPeriod: account.subscriptionResetPeriod,
        subscriptionNextResetAt: account.subscriptionNextResetAt,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      }),
    };
  },
);

function envBindingsRequireModel(
  envBindings: ModelProviderEnvBindings,
): boolean {
  return Object.values(envBindings).some((value) => {
    return value.includes("$model");
  });
}

function resolveModelProviderModel(args: {
  readonly type: ModelProviderType;
  readonly selectedModel: string | null;
  readonly defaultModel: string | undefined;
  readonly envBindings: ModelProviderEnvBindings | undefined;
}): string | null {
  let model = args.selectedModel;
  if (model === null && args.defaultModel !== undefined) {
    model = args.defaultModel;
  }
  if (
    args.envBindings &&
    envBindingsRequireModel(args.envBindings) &&
    !model &&
    args.defaultModel !== ""
  ) {
    throw new Error(`Missing model for model provider ${args.type}`);
  }
  return model === "" ? null : model;
}

function modelProviderEnvironmentSecretValue(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
): string {
  return getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : secretValue;
}

function providerEnvironmentFromSecretRefs(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
  selectedModel: string | null,
): Record<string, string> {
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return {
      [secretName]: modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      ),
    };
  }

  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      environment[key] = modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      );
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const referencedSecret = value.slice("$secrets.".length);
      if (referencedSecret === secretName) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          referencedSecret,
          secretValue,
        );
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function builtInModelProviderEnvironmentFromSnapshot(args: {
  readonly route: BuiltInModelRuntimeRoute;
  readonly selectedModel: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly apiKey: string;
}): ResolvedModelProviderEnvironment | null {
  const { route, selectedModel, featureSwitchContext } = args;
  const key = { apiKey: args.apiKey };
  const secretName = getSecretNameForType(route.providerType);
  if (!secretName) {
    return null;
  }
  const environment = providerEnvironmentFromSecretRefs(
    route.providerType,
    secretName,
    key.apiKey,
    route.upstreamModel,
  );
  const routing = {
    credentialOwner: "builtin" as const,
    model: route.upstreamModel,
    usRoutingEnabled: isFeatureEnabled(
      FeatureSwitchKey.OpenRouterUsRouting,
      featureSwitchContext,
    ),
  };
  const firewall = getModelProviderFirewall(route.providerType, routing);
  const usesUsEndpoint = firewall?.apis.some((api) => {
    return api.base.startsWith(`${OPENROUTER_US_ORIGIN}/`);
  });
  if (route.providerType === "openrouter-api-key") {
    environment.ANTHROPIC_BASE_URL = getOpenRouterBaseUrl("messages", routing);
  } else if (route.providerType === "openrouter-codex") {
    environment.OPENAI_BASE_URL = getOpenRouterBaseUrl("responses", routing);
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type: route.providerType,
    logicalModel: selectedModel,
    runtimeModel: route.upstreamModel,
    environment,
  });

  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    environment,
    secrets: { [secretName]: key.apiKey },
    selectedModel,
    builtInModelRuntimeRoute: route,
    upstreamModel: route.upstreamModel,
    ...(usesUsEndpoint ? { firewall } : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

function modelCredentialsAreUsable(
  source: ModelSourceSnapshot,
  type: ModelProviderType,
  credentials: ModelCredentialValues,
): boolean {
  if (hasAuthMethods(type)) {
    const method =
      source.configuration.kind === "registered-provider"
        ? source.configuration.authMethod
        : null;
    const rules = method ? getSecretsForAuthMethod(type, method) : undefined;
    return (
      rules !== undefined &&
      Object.entries(rules).every(([name, rule]) => {
        return !rule.required || !!credentials[name];
      })
    );
  }
  const name = getSecretNameForType(type);
  return name !== undefined && name !== null && !!credentials[name]?.trim();
}

function selectedSourceUpstream(
  catalog: ModelCatalog,
  source: ModelSourceSnapshot,
  type: ModelProviderType,
  logicalModel: string,
  piExecution: boolean | undefined,
): string | null {
  const cloud = type === "aws-bedrock" || type === "azure-foundry";
  const upstream =
    cloud && source.configuration.kind === "registered-provider"
      ? source.configuration.configuredModel
      : catalogProviderUpstreamModel(catalog, logicalModel, type);
  if (
    cloud &&
    piExecution &&
    !isCloudModelMappingValid(
      type,
      logicalModel,
      upstream,
      catalogHasProviderRoute(catalog, logicalModel, type),
      catalog.byModel,
    )
  ) {
    throw new PiNativeConfigurationError(
      "Cloud provider requires its explicitly configured deployment or profile",
    );
  }
  return upstream;
}

function capturesPiProviderSecret(
  catalog: ModelCatalog,
  model: string,
  piExecution: boolean | undefined,
): boolean {
  const routeClass = piCatalogModel(catalog, model)?.piRouteClass;
  return (
    piExecution === true &&
    (routeClass === "claude-native" || routeClass === "deepseek")
  );
}

/**
 * Firewall-resolved credentials: each stored secret's runtime reference. A
 * missing secret row yields no reference, so the usability check rejects the
 * source as unavailable (fail-closed, as on main).
 */
function deferredCredentialReferences(
  source: ModelSourceSnapshot,
): ModelCredentialValues {
  const values: Record<string, string> = {};
  for (const credential of source.credentials) {
    if (credential.kind === "encrypted") {
      values[credential.name] = `\${{ secrets.${credential.name} }}`;
    }
  }
  return values;
}

/**
 * A ChatGPT account's credentials stay server-side, as on main: firewall auth
 * resolves its stored token rows by name, so only rows of its own auth method
 * become references. A non-Pi run decrypts just CHATGPT_ACCOUNT_ID, which
 * workspace routing compares with the account check; it is not a credential.
 */
async function codexAccountCredentials(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  piExecution: boolean | undefined,
): Promise<ModelCredentialValues | null> {
  const method =
    source.configuration.kind === "registered-provider"
      ? source.configuration.authMethod
      : null;
  const rules = method
    ? getSecretsForAuthMethod("codex-oauth-token", method)
    : undefined;
  if (!rules) {
    return null;
  }
  const own = {
    ...source,
    credentials: source.credentials.filter((credential) => {
      return credential.name in rules;
    }),
  };
  const references = deferredCredentialReferences(own);
  if (piExecution) {
    return references;
  }
  const account = await resolveModelCredentialValues(db, {
    ...own,
    credentials: own.credentials.filter((credential) => {
      return credential.name === "CHATGPT_ACCOUNT_ID";
    }),
  });
  return account?.CHATGPT_ACCOUNT_ID
    ? { ...references, CHATGPT_ACCOUNT_ID: account.CHATGPT_ACCOUNT_ID }
    : null;
}

async function resolveModelCredentialValues(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
): Promise<ModelCredentialValues | null> {
  const values: Record<string, string> = {};
  for (const credential of source.credentials) {
    if (credential.kind === "encrypted") {
      values[credential.name] = await decryptStoredSecretValue(
        credential.encryptedValue,
      );
    } else {
      if (
        source.identity.kind !== "built-in" ||
        credential.modelKeyId !== source.identity.modelKeyId ||
        source.configuration.kind !== "registered-provider"
      ) {
        throw new Error("Managed key identity mismatch");
      }
      const [key] = await db
        .select({
          vendor: builtInModelKeys.vendor,
          apiKey: builtInModelKeys.apiKey,
        })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.id, credential.modelKeyId))
        .limit(1);
      if (!key?.apiKey) {
        return null;
      }
      if (key.vendor !== source.configuration.managedVendor) {
        throw new Error("Managed key vendor changed");
      }
      values[credential.name] = key.apiKey;
    }
  }
  return values;
}

/** Exact registered/account source → resolved credentials → runtime. */
export async function prepareRegisteredModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  selectedModel: string,
  options: {
    readonly catalog: ModelCatalog;
    readonly userId: string;
    readonly sourceId: string;
    readonly piExecution: boolean | undefined;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  const { catalog, userId, sourceId, piExecution } = options;
  const type = modelProviderTypeSchema.parse(source.configuration.providerType);
  const deferred = getModelProviderFirewall(type) !== undefined;
  const capture = capturesPiProviderSecret(catalog, selectedModel, piExecution);
  // As on main, a firewall-injected single-secret credential that Pi does not
  // capture stays encrypted: the runtime only sees its secret reference.
  const credentials =
    deferred && type === "codex-oauth-token"
      ? await codexAccountCredentials(db, source, piExecution)
      : deferred &&
          !capture &&
          !hasAuthMethods(type) &&
          source.credentials.every((credential) => {
            return credential.kind === "encrypted";
          })
        ? deferredCredentialReferences(source)
        : await resolveModelCredentialValues(db, source);
  if (!credentials) {
    return null;
  }
  if (!modelCredentialsAreUsable(source, type, credentials)) {
    return null;
  }
  const upstreamModel = selectedSourceUpstream(
    catalog,
    source,
    type,
    selectedModel,
    piExecution,
  );
  if (!upstreamModel) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: { kind: "configured", selectedModel, upstreamModel },
    credentials,
  });
  const names = Object.keys(compiled.secrets);
  const sourceUserId =
    source.credentialOwner === "organization" ? ORG_SENTINEL_USER_ID : userId;
  const environment = { ...compiled.environment };
  // Pi owns account routing through its explicit source binding rather
  // than the native Codex CLI-only routing environment variable.
  if (piExecution && type === "codex-oauth-token") {
    delete environment.CODEX_OAUTH_ACCOUNT_ID;
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type,
    logicalModel: compiled.selectedModel,
    runtimeModel: compiled.upstreamModel,
    environment,
  });
  return {
    id: sourceId,
    type,
    credentialOwner: compiled.credentialOwner,
    environment,
    secrets: deferred && !capture ? {} : { ...compiled.secrets },
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    ...(source.configuration.kind === "registered-provider" &&
    source.configuration.authMethod
      ? { authMethod: source.configuration.authMethod }
      : {}),
    ...(deferred
      ? {
          secretConnectorMap: Object.fromEntries(
            names.map((name) => {
              return [name, type];
            }),
          ),
          secretConnectorMetadataMap: Object.fromEntries(
            names.map((name) => {
              return [
                name,
                {
                  sourceType: "model-provider" as const,
                  sourceUserId,
                  ...(source.identity.kind === "member"
                    ? { sourceId: source.identity.accountId }
                    : {}),
                  metadataKey: type,
                },
              ];
            }),
          ),
        }
      : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

/** The run facts a Built-in model environment is prepared from. */
interface ManagedModelEnvironmentRequest {
  readonly catalog: ModelCatalog;
  readonly framework: SupportedFramework;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly featureSwitchContext: FeatureSwitchContext;
}

/** Exact managed-key source → explicit key resolution → managed runtime. */
export async function prepareManagedModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  args: ManagedModelEnvironmentRequest,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (source.identity.kind !== "built-in") {
    throw new Error("Managed preparation requires a managed source");
  }
  const route = args.builtInModelRuntimeRoute;
  if (
    !route ||
    route.selectedModel !== args.selectedModelOverride ||
    !isBuiltInModelRuntimeRoutePermitted(args.catalog, route) ||
    getFrameworkForType(route.providerType) !== args.framework ||
    route.modelKeyId !== source.identity.modelKeyId
  ) {
    return null;
  }
  const credentials = await resolveModelCredentialValues(db, source);
  if (!credentials) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: {
      kind: "built-in",
      selectedModel: route.selectedModel,
      providerType: route.providerType,
      upstreamModel: route.upstreamModel,
      modelKeyId: route.modelKeyId,
    },
    credentials,
  });
  const secretName = getSecretNameForType(route.providerType);
  if (!secretName || !credentials[secretName]) {
    return null;
  }
  // Preserve private US-routing/firewall/Codex protocol without a query.
  const protocol = builtInModelProviderEnvironmentFromSnapshot({
    route,
    selectedModel: route.selectedModel,
    featureSwitchContext: args.featureSwitchContext,
    apiKey: credentials[secretName],
  });
  if (!protocol) {
    return null;
  }
  const environment = { ...compiled.environment };
  if (route.providerType === "openrouter-api-key") {
    const endpoint = protocol.environment.ANTHROPIC_BASE_URL;
    if (!endpoint) {
      throw new Error("Managed messages endpoint is missing");
    }
    environment.ANTHROPIC_BASE_URL = endpoint;
  }
  if (route.providerType === "openrouter-codex") {
    const endpoint = protocol.environment.OPENAI_BASE_URL;
    if (!endpoint) {
      throw new Error("Managed responses endpoint is missing");
    }
    environment.OPENAI_BASE_URL = endpoint;
  }
  return {
    ...protocol,
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    environment,
    secrets: { ...compiled.secrets },
  };
}

/** Exact selected gateway surface → resolved key → gateway runtime. */
export async function prepareGatewayModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  selection: {
    readonly selectedModel: string | undefined;
    readonly framework: string;
    readonly modelProviderType: string | undefined;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  const config = source.configuration;
  if (source.identity.kind !== "gateway" || config.kind !== "gateway") {
    throw new Error("Selected gateway has an invalid source kind");
  }
  const { selectedModel } = selection;
  const type = providerTypeForSurfaceProtocol(config.protocol);
  if (!type) {
    throw new Error("Gateway protocol has no provider type");
  }
  if (
    !selectedModel ||
    !config.modelMappings[selectedModel] ||
    getFrameworkForType(type) !== selection.framework ||
    (selection.modelProviderType !== undefined &&
      selection.modelProviderType !== type)
  ) {
    return null;
  }
  const credentials = await resolveModelCredentialValues(db, source);
  // A blank stored gateway key is an unavailable source, as on main.
  if (!credentials?.[GATEWAY_RUNTIME_SECRET_NAME]?.trim()) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: {
      kind: "configured",
      selectedModel,
      upstreamModel: config.modelMappings[selectedModel],
    },
    credentials,
  });
  // Supplementary Runner firewall/Codex protocol is pure assembly from the
  // same complete snapshot, not another query.
  const protocol = compileModelProviderGatewayRuntime({
    surfaceId: source.identity.surfaceId,
    protocol: config.protocol,
    apiBaseUrl: config.apiBaseUrl,
    displayName: config.displayName,
    authHeaderName: config.authHeaderName,
    authHeaderTemplate: config.authHeaderTemplate,
    logicalModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
  });
  return {
    id: source.identity.surfaceId,
    type,
    credentialOwner: compiled.credentialOwner,
    environment: { ...compiled.environment },
    secrets: { ...compiled.secrets },
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    firewall: protocol.firewall,
    inlineFirewall: true,
    credentialHeader: {
      name: config.authHeaderName,
      valueTemplate: config.authHeaderTemplate,
    },
    ...(protocol.codexRuntimeConfig
      ? { codexRuntimeConfig: protocol.codexRuntimeConfig }
      : {}),
  };
}

function resolveModelProviderCodexRuntimeConfig(args: {
  readonly type: ModelProviderType;
  readonly logicalModel: string | null;
  readonly runtimeModel: string;
  readonly environment: Readonly<Record<string, string>>;
}): ModelProviderCodexRuntimeConfig | undefined {
  const providerConfig = getModelProviderCodexRuntimeConfig(args.type);
  if (providerConfig) {
    return providerConfig;
  }
  const providerCapabilities = getModelProviderCodexRuntimeCapabilities(
    args.type,
  );
  if (!providerCapabilities) {
    return undefined;
  }
  const modelCatalog = args.logicalModel
    ? getModelProviderCodexCatalogForModel(
        args.logicalModel,
        args.runtimeModel,
        args.type,
      )
    : undefined;
  const baseUrl = args.environment.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(`Missing OPENAI_BASE_URL for Codex provider ${args.type}`);
  }
  return {
    providerId: args.type,
    name: MODEL_PROVIDER_TYPES[args.type].label,
    baseUrl,
    envKey: "OPENAI_API_KEY",
    requiresOpenaiAuth: false,
    wireApi: "responses",
    supportsWebsockets: providerCapabilities.supportsWebsockets,
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}
