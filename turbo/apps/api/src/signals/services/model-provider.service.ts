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
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { modelProviders as modelProvidersTable } from "@okouai/db/schema/model-provider";
import { modelProviderConnections } from "@okouai/db/schema/model-provider-gateway";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { db$, writeDb$ } from "../external/db";
import {
  publishModelPoliciesChangedForOrgSafely,
  publishPersonalModelProvidersChangedSafely,
} from "../external/realtime";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { encryptStoredSecretValue } from "./crypto.utils";
import { modelProviderStateLockStatement } from "./auth-state-lock.service";
import { userFeatureSwitchContext } from "./feature-switches.service";

import {
  disconnectPersonalModelProviderAccounts$,
  isPersonalSubscriptionProviderType,
  upsertPersonalModelProviderAccount$,
  type UpsertPersonalAccountArgs,
  visiblePersonalModelProviderCondition,
} from "./model-provider-account.service";

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
      // R1 compatibility only: origin/main settings writers
      // (persistMultiAuthModelProvider, deleteUserModelProvider$) read the
      // provider unlocked and write secrets before the provider row, and
      // origin/main refresh (refreshAccessTokenForSource) holds this key across
      // provider I/O. They serialize only through this key. R2 removes this
      // acquisition once no serving, in-flight or rollback origin/main writer
      // takes model_provider_state. New writers do not rely on it: each one
      // writes the provider row first, so the row's implicit lock orders them.
      await tx.execute(modelProviderStateLockStatement(args));
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
      // R1 compatibility only: origin/main persistMultiAuthModelProvider and
      // deleteUserModelProvider$ read the provider unlocked and write secrets
      // before the provider row; origin/main refreshAccessTokenForSource holds
      // this key across provider I/O. R2 removes this acquisition once no
      // serving, in-flight or rollback origin/main writer takes
      // model_provider_state. New writers do not rely on it.
      await tx.execute(modelProviderStateLockStatement(args));
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
