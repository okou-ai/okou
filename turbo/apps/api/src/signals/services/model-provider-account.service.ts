import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";

import { settle } from "../utils";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { publishPersonalModelProvidersChangedSafely } from "../external/realtime";
import { lockModelProviderState } from "./auth-state-lock.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { extractCodexAccountEmailFromIdToken } from "./codex-auth-json-parser";
import { invalidateCodexResetCreditExpiry } from "./codex-reset-credit-expiry.service";
import { fetchClaudeCodeProfileMetadata } from "./claude-code-usage.service";

const MAX_PERSONAL_PROVIDER_ACCOUNTS = 10;
const CODEX_TYPE = "codex-oauth-token";
const CLAUDE_CODE_TYPE = "claude-code-oauth-token";
const CODEX_ACCOUNT_ID_SECRET = "CHATGPT_ACCOUNT_ID";
const CODEX_ID_TOKEN_SECRET = "CHATGPT_ID_TOKEN";

export type PersonalSubscriptionProviderType =
  | typeof CODEX_TYPE
  | typeof CLAUDE_CODE_TYPE;

export function isPersonalSubscriptionProviderType(
  type: string,
): type is PersonalSubscriptionProviderType {
  return type === CODEX_TYPE || type === CLAUDE_CODE_TYPE;
}

interface PersonalProviderAccountMetadata {
  readonly externalAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

export type PersonalProviderAccountMutation =
  | { readonly kind: "add" }
  | { readonly kind: "replace-active" }
  | { readonly kind: "reconnect"; readonly accountId: string };

interface EncryptedAccountSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

type AccountRow = typeof modelProviderAccounts.$inferSelect;
type ProviderRow = typeof modelProviders.$inferSelect;
export type PersonalProviderAccountErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>;

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizedEmail(value: string | null | undefined): string | null {
  return normalizedText(value)?.toLowerCase() ?? null;
}

function accountResponse(args: {
  readonly account: AccountRow;
  readonly provider: ProviderRow;
}): ModelProviderResponse {
  const { account, provider } = args;
  const type = account.type as PersonalSubscriptionProviderType;
  const authMethod = account.authMethod;
  return {
    id: account.id,
    modelProviderId: provider.id,
    isActive: account.isActive,
    type,
    framework: getFrameworkForType(type),
    secretName: getSecretNameForType(type) ?? null,
    authMethod,
    secretNames: authMethod
      ? (getSecretNamesForAuthMethod(type, authMethod) ?? null)
      : null,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    accountEmail: account.accountEmail,
    workspaceName: account.workspaceName,
    planType: account.planType,
    subscriptionResetPeriod: account.subscriptionResetPeriod,
    subscriptionNextResetAt:
      account.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: account.needsReconnect,
    lastRefreshErrorCode: account.lastRefreshErrorCode,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

async function encryptAccountSecrets(
  type: PersonalSubscriptionProviderType,
  values: Readonly<Record<string, string>>,
  featureSwitchContext: FeatureSwitchContext,
  signal: AbortSignal,
): Promise<readonly EncryptedAccountSecret[]> {
  const encrypted: EncryptedAccountSecret[] = [];
  for (const [name, value] of Object.entries(values)) {
    encrypted.push({
      name,
      encryptedValue: await encryptStoredSecretValue(
        value,
        featureSwitchContext,
      ),
      description: `Personal ${type} account secret: ${name}`,
    });
    signal.throwIfAborted();
  }
  return encrypted;
}

async function legacySecretRows(
  db: Db,
  provider: ProviderRow,
): Promise<readonly EncryptedAccountSecret[]> {
  if (provider.secretId) {
    const rows = await db
      .select({
        name: secrets.name,
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.id, provider.secretId),
          eq(secrets.orgId, provider.orgId),
          eq(secrets.userId, provider.userId),
          eq(secrets.type, "model-provider"),
        ),
      )
      .for("no key update");
    return rows.map((row) => {
      return {
        name: row.name,
        encryptedValue: row.encryptedValue,
        description:
          row.description ?? `Personal ${provider.type} account secret`,
      };
    });
  }

  if (
    !provider.authMethod ||
    !isPersonalSubscriptionProviderType(provider.type)
  ) {
    return [];
  }
  const names = getSecretNamesForAuthMethod(provider.type, provider.authMethod);
  if (!names || names.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
      description: secrets.description,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, provider.orgId),
        eq(secrets.userId, provider.userId),
        eq(secrets.type, "model-provider"),
        inArray(secrets.name, [...names]),
      ),
    )
    .for("no key update");
  return rows.map((row) => {
    return {
      name: row.name,
      encryptedValue: row.encryptedValue,
      description:
        row.description ?? `Personal ${provider.type} account secret`,
    };
  });
}

async function insertAccountSecrets(
  db: Db,
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
): Promise<void> {
  if (encryptedSecrets.length === 0) {
    return;
  }
  await db.insert(modelProviderAccountSecrets).values(
    encryptedSecrets.map((secret) => {
      return {
        modelProviderAccountId: accountId,
        ...secret,
      };
    }),
  );
}

async function seedLegacyAccount(
  db: Db,
  provider: ProviderRow,
): Promise<AccountRow | null> {
  const encryptedSecrets = await legacySecretRows(db, provider);
  if (encryptedSecrets.length === 0) {
    return null;
  }
  const [account] = await db
    .insert(modelProviderAccounts)
    .values({
      modelProviderId: provider.id,
      orgId: provider.orgId,
      userId: provider.userId,
      type: provider.type,
      authMethod: provider.authMethod,
      isActive: true,
      workspaceName: provider.workspaceName,
      planType: provider.planType,
      tokenExpiresAt: provider.tokenExpiresAt,
      needsReconnect: provider.needsReconnect,
      lastRefreshErrorCode: provider.lastRefreshErrorCode,
      subscriptionResetPeriod: provider.subscriptionResetPeriod,
      subscriptionNextResetAt: provider.subscriptionNextResetAt,
    })
    .returning();
  if (!account) {
    throw new Error(
      "Expected personal model provider account insert to return",
    );
  }
  await insertAccountSecrets(db, account.id, encryptedSecrets);
  return account;
}

async function hydrateSeededCodexIdentity(args: {
  readonly db: Db;
  readonly account: AccountRow;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (args.account.type !== CODEX_TYPE) {
    return;
  }
  const rows = await args.db
    .select({
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
    })
    .from(modelProviderAccountSecrets)
    .where(
      and(
        eq(modelProviderAccountSecrets.modelProviderAccountId, args.account.id),
        inArray(modelProviderAccountSecrets.name, [
          CODEX_ACCOUNT_ID_SECRET,
          CODEX_ID_TOKEN_SECRET,
        ]),
      ),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(
      row.name,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
  }
  await args.db
    .update(modelProviderAccounts)
    .set({
      externalAccountId: normalizedText(values.get(CODEX_ACCOUNT_ID_SECRET)),
      accountEmail: normalizedEmail(
        extractCodexAccountEmailFromIdToken(values.get(CODEX_ID_TOKEN_SECRET)),
      ),
      updatedAt: nowDate(),
    })
    .where(eq(modelProviderAccounts.id, args.account.id));
}

/** Lazily seed the first account from the actual legacy singleton. Removal is
 * owned by #34010 after seeding is complete and observed serving-writer,
 * persisted-context and rollback gates close; elapsed deployment time alone
 * cannot establish that boundary. Retained-only parents are not empty seeds.
 */
async function seedPersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly provider: ProviderRow;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (!isPersonalSubscriptionProviderType(args.provider.type)) {
    return;
  }
  const [existing] = await args.db
    .select({ id: modelProviderAccounts.id })
    .from(modelProviderAccounts)
    .where(eq(modelProviderAccounts.modelProviderId, args.provider.id))
    .limit(1);
  if (existing) {
    return;
  }

  await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.provider.orgId,
      userId: args.provider.userId,
      type: args.provider.type,
    });
    const [current] = await tx
      .select()
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.modelProviderId, args.provider.id))
      .limit(1);
    if (current) {
      return;
    }
    const [provider] = await tx
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, args.provider.id))
      .for("no key update")
      .limit(1);
    if (!provider) {
      return;
    }
    const account = await seedLegacyAccount(tx, provider);
    if (account) {
      await hydrateSeededCodexIdentity({
        db: tx,
        account,
        featureSwitchContext: args.featureSwitchContext,
      });
    }
  });
}

async function providerRowsForPersonalAccounts(
  db: Db,
  orgId: string,
  userId: string,
): Promise<readonly ProviderRow[]> {
  const rows = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        inArray(modelProviders.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
      ),
    );
  return rows.filter((row) => {
    return isPersonalSubscriptionProviderType(row.type);
  });
}

export async function listPersonalModelProviderAccounts(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal?: AbortSignal,
): Promise<ModelProviderListResponse> {
  const providers = await providerRowsForPersonalAccounts(
    args.db,
    args.orgId,
    args.userId,
  );
  const unavailable = new Set<string>();
  for (const provider of providers) {
    const ready = await ensurePersonalModelProviderAccount(
      {
        db: args.db,
        provider,
        featureSwitchContext: args.featureSwitchContext,
      },
      signal,
    );
    if (!ready) {
      unavailable.add(provider.id);
    }
  }

  const rows = await args.db
    .select({ account: modelProviderAccounts, provider: modelProviders })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviders,
      eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    )
    .where(
      and(
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        inArray(modelProviderAccounts.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    )
    .orderBy(
      modelProviderAccounts.type,
      desc(modelProviderAccounts.isActive),
      asc(modelProviderAccounts.createdAt),
      asc(modelProviderAccounts.id),
    );
  return {
    modelProviders: rows.map((row) => {
      return accountResponse({
        ...row,
        account:
          unavailable.has(row.provider.id) && row.account.isActive
            ? { ...row.account, needsReconnect: true }
            : row.account,
      });
    }),
  };
}

function accountMetadataValues(args: {
  readonly type: PersonalSubscriptionProviderType;
  readonly metadata: PersonalProviderAccountMetadata | undefined;
  readonly secretValues: Readonly<Record<string, string>>;
}) {
  const externalAccountId =
    args.type === CODEX_TYPE
      ? normalizedText(
          args.metadata?.externalAccountId ??
            args.secretValues[CODEX_ACCOUNT_ID_SECRET],
        )
      : normalizedText(args.metadata?.externalAccountId);
  return {
    externalAccountId,
    accountEmail: normalizedEmail(args.metadata?.accountEmail),
    workspaceName: normalizedText(args.metadata?.workspaceName),
    planType: normalizedText(args.metadata?.planType),
    tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    subscriptionResetPeriod: normalizedText(
      args.metadata?.subscriptionResetPeriod,
    ),
    subscriptionNextResetAt: args.metadata?.subscriptionNextResetAt ?? null,
    updatedAt: nowDate(),
  };
}

function sameClaudeIdentity(
  account: AccountRow,
  email: string | null,
  workspaceName: string | null,
): boolean {
  return (
    email !== null &&
    workspaceName !== null &&
    normalizedEmail(account.accountEmail) === email &&
    normalizedText(account.workspaceName)?.toLowerCase() ===
      workspaceName.toLowerCase()
  );
}

function identityMatches(
  account: AccountRow,
  type: PersonalSubscriptionProviderType,
  metadata: ReturnType<typeof accountMetadataValues>,
): boolean {
  if (type === CODEX_TYPE) {
    return (
      metadata.externalAccountId !== null &&
      account.externalAccountId === metadata.externalAccountId
    );
  }
  if (account.externalAccountId && metadata.externalAccountId) {
    return account.externalAccountId === metadata.externalAccountId;
  }
  // Older OAuth connections recorded email/workspace before upstream UUIDs.
  // Match only that stored identity, never metadata from today's active row.
  return sameClaudeIdentity(
    account,
    metadata.accountEmail,
    metadata.workspaceName,
  );
}

async function upsertLegacySecret(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly secret: EncryptedAccountSecret;
  },
): Promise<string> {
  const [row] = await db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.secret.name,
      encryptedValue: args.secret.encryptedValue,
      type: "model-provider",
      description: args.secret.description,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      targetWhere: isNull(secrets.connectorId),
      set: {
        encryptedValue: args.secret.encryptedValue,
        description: args.secret.description,
        updatedAt: nowDate(),
      },
    })
    .returning({ id: secrets.id });
  if (!row) {
    throw new Error("Expected legacy model provider secret upsert to return");
  }
  return row.id;
}

/** Rollout bridge for singleton readers/writers, including immutable rollback
 * artifacts. Active account writes copy the SAME ciphertext bundle in their
 * transaction; inactive writes never mirror. Removal is owned by #34010 after
 * writer drain, sourceId-less/pre-stability context drain, and an executable
 * rollback floor containing the fully accepted feature. See the identity guide.
 */
async function mirrorAccountToLegacy(
  db: Db,
  args: {
    readonly account: AccountRow;
    readonly provider: ProviderRow;
  },
): Promise<void> {
  const accountSecrets = await db
    .select({
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
      description: modelProviderAccountSecrets.description,
    })
    .from(modelProviderAccountSecrets)
    .where(
      eq(modelProviderAccountSecrets.modelProviderAccountId, args.account.id),
    );
  let secretId: string | null = null;
  for (const secret of accountSecrets) {
    const id = await upsertLegacySecret(db, {
      orgId: args.account.orgId,
      userId: args.account.userId,
      secret: {
        ...secret,
        description:
          secret.description ??
          `Personal ${args.account.type} account secret: ${secret.name}`,
      },
    });
    if (
      getSecretNameForType(args.account.type as ModelProviderType) ===
      secret.name
    ) {
      secretId = id;
    }
  }
  await db
    .update(modelProviders)
    .set({
      authMethod: args.account.authMethod,
      secretId,
      tokenExpiresAt: args.account.tokenExpiresAt,
      needsReconnect: args.account.needsReconnect,
      lastRefreshErrorCode: args.account.lastRefreshErrorCode,
      workspaceName: args.account.workspaceName,
      planType: args.account.planType,
      subscriptionResetPeriod: args.account.subscriptionResetPeriod,
      subscriptionNextResetAt: args.account.subscriptionNextResetAt,
      updatedAt: nowDate(),
    })
    .where(eq(modelProviders.id, args.provider.id));
}

async function createLogicalProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly selectedModel: string | undefined;
  },
): Promise<ProviderRow> {
  const [provider] = await db
    .insert(modelProviders)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      isDefault: false,
      selectedModel: args.selectedModel ?? null,
    })
    .returning();
  if (!provider) {
    throw new Error("Expected logical model provider insert to return");
  }
  return provider;
}

function selectMutationTarget(args: {
  readonly accounts: readonly AccountRow[];
  readonly mode: PersonalProviderAccountMutation;
  readonly type: PersonalSubscriptionProviderType;
  readonly metadata: ReturnType<typeof accountMetadataValues>;
}): AccountRow | null | ReturnType<typeof notFound> {
  if (args.mode.kind === "reconnect") {
    const accountId = args.mode.accountId;
    return (
      args.accounts.find((account) => {
        return account.id === accountId;
      }) ?? notFound("Resource not found")
    );
  }
  if (args.mode.kind === "replace-active") {
    return (
      args.accounts.find((account) => {
        return account.isActive;
      }) ?? null
    );
  }
  return (
    args.accounts.find((account) => {
      return identityMatches(account, args.type, args.metadata);
    }) ?? null
  );
}

async function replaceAccountSecrets(
  db: Db,
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
): Promise<void> {
  await db
    .delete(modelProviderAccountSecrets)
    .where(eq(modelProviderAccountSecrets.modelProviderAccountId, accountId));
  await insertAccountSecrets(db, accountId, encryptedSecrets);
}

async function applyAccountMutation(
  db: Db,
  args: {
    readonly provider: ProviderRow;
    readonly accounts: readonly AccountRow[];
    readonly type: PersonalSubscriptionProviderType;
    readonly authMethod: string | null;
    readonly mode: PersonalProviderAccountMutation;
    readonly metadata: ReturnType<typeof accountMetadataValues>;
    readonly encryptedSecrets: readonly EncryptedAccountSecret[];
    readonly retainReplaced: boolean;
  },
): Promise<
  | { readonly account: AccountRow; readonly created: boolean }
  | ReturnType<typeof notFound>
  | ReturnType<typeof badRequestMessage>
> {
  const connected = args.accounts.filter((account) => {
    return account.disconnectedAt === null;
  });
  const target = selectMutationTarget({ ...args, accounts: connected });
  if (target && "status" in target) {
    return target;
  }
  return await applyStableAccountMutation(db, args, target);
}

function affectedCodexExpiryBindings(
  args: Parameters<typeof selectMutationTarget>[0],
): (string | null)[] {
  if (args.type !== CODEX_TYPE) {
    return [];
  }
  const selected = selectMutationTarget(args);
  if (selected && "status" in selected) {
    return [];
  }
  // Fence replaced/deleted rows even when reconnect changes upstream identity.
  // Unrelated concrete accounts retain their values and Retry-After deadlines.
  return [
    null,
    ...args.accounts
      .filter((account) => {
        return (
          account.id === selected?.id ||
          identityMatches(account, args.type, args.metadata)
        );
      })
      .map((account) => {
        return account.id;
      }),
  ];
}

type UpsertPersonalAccountArgs = {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly authMethod: string | null;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly selectedModel?: string;
  readonly metadata?: PersonalProviderAccountMetadata;
  readonly mode: PersonalProviderAccountMutation;
  readonly featureSwitchContext: FeatureSwitchContext;
};

type UpsertPersonalAccountResult =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly provider: ModelProviderResponse;
      readonly created: boolean;
    };

async function resolveConnectionIdentityMetadata(
  args: UpsertPersonalAccountArgs,
  signal: AbortSignal,
): Promise<PersonalProviderAccountMetadata | undefined> {
  const accessToken = args.secretValues.CLAUDE_CODE_OAUTH_TOKEN;
  if (
    args.type !== CLAUDE_CODE_TYPE ||
    !accessToken ||
    args.metadata?.accountEmail
  ) {
    return args.metadata;
  }
  const profile = await settle(
    fetchClaudeCodeProfileMetadata({ accessToken }, signal),
  );
  signal.throwIfAborted();
  return profile.ok ? { ...args.metadata, ...profile.value } : args.metadata;
}

async function preparePersonalAccountConnection(
  args: UpsertPersonalAccountArgs,
  signal: AbortSignal,
) {
  const existingProviders = await providerRowsForPersonalAccounts(
    args.db,
    args.orgId,
    args.userId,
  );
  const existingProvider = existingProviders.find((provider) => {
    return provider.type === args.type;
  });
  if (existingProvider) {
    await seedPersonalModelProviderAccount({
      db: args.db,
      provider: existingProvider,
      featureSwitchContext: args.featureSwitchContext,
    });
  }
  signal.throwIfAborted();

  return args.type === CLAUDE_CODE_TYPE && existingProvider
    ? await prepareClaudeAccountIdentities(args, signal)
    : null;
}

export async function upsertPersonalModelProviderAccount(
  args: UpsertPersonalAccountArgs,
  signal: AbortSignal,
): Promise<UpsertPersonalAccountResult> {
  const retainReplaced = isFeatureEnabled(
    FeatureSwitchKey.PersonalSubscriptionPriority,
    args.featureSwitchContext,
  );
  const resolvedMetadata = await resolveConnectionIdentityMetadata(
    args,
    signal,
  );
  signal.throwIfAborted();
  const encryptedSecrets = await encryptAccountSecrets(
    args.type,
    args.secretValues,
    args.featureSwitchContext,
    signal,
  );
  const identityProof = await preparePersonalAccountConnection(args, signal);
  signal.throwIfAborted();

  const expiryBindings = new Set<string | null>();
  const invalidateExpiry = () => {
    for (const binding of expiryBindings) {
      invalidateCodexResetCreditExpiry(
        { scope: "personal", orgId: args.orgId, userId: args.userId },
        { binding },
      );
    }
  };
  const result = await args.db
    .transaction(async (tx) => {
      await lockModelProviderState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
      });
      signal.throwIfAborted();
      const [providerRow] = await tx
        .select()
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.type, args.type),
          ),
        )
        .limit(1);
      if (!providerRow && identityProof) {
        return notFound("Resource not found");
      }
      const provider =
        providerRow ??
        (await createLogicalProvider(tx, {
          orgId: args.orgId,
          userId: args.userId,
          type: args.type,
          selectedModel: args.selectedModel,
        }));
      // A provider inserted by this transaction cannot yet own visible accounts.
      // Its first bundle is still published atomically through the same writer.
      const currentSnapshot = providerRow
        ? await lockSubscriptionCredentialSnapshot({ ...args, db: tx })
        : {
            provider,
            accounts: [],
            mirror: [],
            accountSecrets: [],
            active: undefined,
          };
      if (!currentSnapshot) {
        throw new Error("Expected the connected provider snapshot");
      }
      if (
        identityProof &&
        JSON.stringify(identityProof.snapshot) !==
          JSON.stringify(currentSnapshot)
      ) {
        return notFound("Resource not found");
      }
      const accounts = await applyClaudeIdentityProof(
        tx,
        currentSnapshot.accounts,
        identityProof,
      );
      signal.throwIfAborted();
      const metadata = accountMetadataValues({
        type: args.type,
        metadata: resolvedMetadata,
        secretValues: args.secretValues,
      });
      for (const binding of affectedCodexExpiryBindings({
        accounts,
        mode: args.mode,
        type: args.type,
        metadata,
      })) {
        expiryBindings.add(binding);
      }
      invalidateExpiry();
      const result = await applyAccountMutation(tx, {
        provider,
        accounts,
        type: args.type,
        authMethod: args.authMethod,
        mode: args.mode,
        metadata,
        encryptedSecrets,
        retainReplaced,
      });
      if ("status" in result) {
        return result;
      }
      return {
        provider: accountResponse({
          account: result.account,
          provider: await persistSubscriptionSelectedModel(tx, provider, args),
        }),
        created: result.created,
      };
    })
    .finally(invalidateExpiry);
  if (!("status" in result)) {
    await publishPersonalModelProvidersChangedSafely(args.userId);
  }
  return result;
}

async function persistSubscriptionSelectedModel(
  db: Db,
  provider: ProviderRow,
  args: Pick<UpsertPersonalAccountArgs, "mode" | "selectedModel">,
): Promise<ProviderRow> {
  const selectedModel =
    args.mode.kind === "replace-active"
      ? (args.selectedModel ?? null)
      : provider.selectedModel;
  if (selectedModel !== provider.selectedModel) {
    await db
      .update(modelProviders)
      .set({ selectedModel, updatedAt: nowDate() })
      .where(eq(modelProviders.id, provider.id));
  }
  return { ...provider, selectedModel };
}

async function prepareClaudeAccountIdentities(
  args: SubscriptionCredentialOwner,
  signal: AbortSignal,
) {
  const snapshot = await args.db.transaction(async (tx) => {
    return await lockSubscriptionCredentialSnapshot({ ...args, db: tx });
  });
  if (!snapshot) {
    return null;
  }
  const identities = new Map<string, PersonalProviderAccountMetadata>();
  for (const account of snapshot.accounts) {
    if (hasClaudeIdentity(account) || account.disconnectedAt !== null) {
      continue;
    }
    const secret = snapshot.accountSecrets.find((row) => {
      return (
        row.modelProviderAccountId === account.id &&
        row.name === "CLAUDE_CODE_OAUTH_TOKEN"
      );
    });
    if (!secret) {
      continue;
    }
    const accessToken = await decryptStoredSecretValue(
      secret.encryptedValue,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    const result = await settle(
      fetchClaudeCodeProfileMetadata({ accessToken }, signal),
    );
    signal.throwIfAborted();
    if (
      result.ok &&
      (result.value.externalAccountId ||
        (result.value.accountEmail && result.value.workspaceName))
    ) {
      identities.set(account.id, result.value);
    }
  }
  return identities.size === 0 ? null : { snapshot, identities };
}

/** Identify legacy Claude accounts before the all-account disconnect transaction.
 * This only records a proven identity under CAS; removal still owns its complete
 * connected set, and a concurrent winning write cannot receive stale proof. */
export async function identifyPersonalSubscriptionAccountsBeforeDisconnect(
  args: SubscriptionCredentialOwner,
  signal: AbortSignal,
): Promise<void> {
  if (args.type !== CLAUDE_CODE_TYPE) {
    return;
  }
  const proof = await prepareClaudeAccountIdentities(args, signal);
  signal.throwIfAborted();
  if (!proof) {
    return;
  }
  await args.db.transaction(async (tx) => {
    const current = await lockSubscriptionCredentialSnapshot({
      ...args,
      db: tx,
    });
    signal.throwIfAborted();
    if (current && JSON.stringify(current) === JSON.stringify(proof.snapshot)) {
      await applyClaudeIdentityProof(tx, current.accounts, proof);
    }
  });
}

async function applyClaudeIdentityProof(
  db: Db,
  accounts: readonly AccountRow[],
  proof: Awaited<ReturnType<typeof prepareClaudeAccountIdentities>>,
): Promise<readonly AccountRow[]> {
  const hydrated: AccountRow[] = [];
  for (const account of accounts) {
    const metadata = proof?.identities.get(account.id);
    if (!metadata) {
      hydrated.push(account);
      continue;
    }
    const identity = {
      externalAccountId: metadata.externalAccountId ?? null,
      accountEmail: metadata.accountEmail ?? null,
      workspaceName: metadata.workspaceName ?? null,
    };
    await db
      .update(modelProviderAccounts)
      .set(identity)
      .where(eq(modelProviderAccounts.id, account.id));
    hydrated.push({ ...account, ...identity });
  }
  return hydrated;
}

async function accountWithProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
  },
): Promise<{
  readonly account: AccountRow;
  readonly provider: ProviderRow;
} | null> {
  const [row] = await db
    .select({ account: modelProviderAccounts, provider: modelProviders })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviders,
      eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    )
    .where(
      and(
        eq(modelProviderAccounts.id, args.id),
        isNull(modelProviderAccounts.disconnectedAt),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function activatePersonalModelProviderAccount(
  args: {
    readonly db: Db;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
  },
  signal?: AbortSignal,
): Promise<ModelProviderResponse | ReturnType<typeof notFound>> {
  const initial = await accountWithProvider(args.db, args);
  if (!initial || !isPersonalSubscriptionProviderType(initial.account.type)) {
    return notFound("Resource not found");
  }
  if (
    initial.account.isActive &&
    !(await coordinatePersonalSubscriptionCredentials(
      {
        ...args,
        type: initial.account.type,
        sourceId: args.id,
      },
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  const result = await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: initial.account.type,
    });
    const snapshot = await lockSubscriptionCredentialSnapshot({
      ...args,
      db: tx,
      type: initial.account.type as PersonalSubscriptionProviderType,
    });
    if (
      !snapshot ||
      (snapshot.active?.id === args.id &&
        !(await reconcileLockedSubscriptionSnapshot(
          {
            ...args,
            db: tx,
            type: initial.account.type as PersonalSubscriptionProviderType,
          },
          snapshot,
        )))
    ) {
      return notFound("Resource not found");
    }
    const current = await accountWithProvider(tx, args);
    if (!current) {
      return notFound("Resource not found");
    }
    await tx
      .update(modelProviderAccounts)
      .set({ isActive: false, updatedAt: nowDate() })
      .where(eq(modelProviderAccounts.modelProviderId, current.provider.id));
    const [account] = await tx
      .update(modelProviderAccounts)
      .set({ isActive: true, updatedAt: nowDate() })
      .where(eq(modelProviderAccounts.id, current.account.id))
      .returning();
    if (!account) {
      throw new Error("Expected activated model provider account to return");
    }
    await mirrorAccountToLegacy(tx, { account, provider: current.provider });
    return accountResponse({ account, provider: current.provider });
  });
  if (!("status" in result)) {
    await publishPersonalModelProvidersChangedSafely(args.userId);
  }
  return result;
}

async function deleteLastAccount(
  db: Db,
  args: { readonly account: AccountRow; readonly provider: ProviderRow },
): Promise<void> {
  const legacyNames = args.account.authMethod
    ? getSecretNamesForAuthMethod(
        args.account.type as ModelProviderType,
        args.account.authMethod,
      )
    : [getSecretNameForType(args.account.type as ModelProviderType)].filter(
        (name): name is string => {
          return name !== undefined;
        },
      );
  await db
    .update(modelProviders)
    .set({ secretId: null, authMethod: null, updatedAt: nowDate() })
    .where(eq(modelProviders.id, args.provider.id));
  const [retained] = await db
    .select({ id: modelProviderAccounts.id })
    .from(modelProviderAccounts)
    .where(eq(modelProviderAccounts.modelProviderId, args.provider.id))
    .limit(1);
  if (!retained) {
    await db
      .delete(modelProviders)
      .where(eq(modelProviders.id, args.provider.id));
  }
  if (legacyNames && legacyNames.length > 0) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.account.orgId),
          eq(secrets.userId, args.account.userId),
          eq(secrets.type, "model-provider"),
          inArray(secrets.name, [...legacyNames]),
        ),
      );
  }
}

export async function deletePersonalModelProviderAccount(
  args: {
    readonly db: Db;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
    readonly disconnectAll?: boolean;
  },
  signal: AbortSignal,
): Promise<ReturnType<typeof notFound> | undefined> {
  const initial = await accountWithProvider(args.db, args);
  if (!initial || !isPersonalSubscriptionProviderType(initial.account.type)) {
    return notFound("Resource not found");
  }
  if (
    !args.disconnectAll &&
    initial.account.isActive &&
    !(await coordinatePersonalSubscriptionCredentials(
      { ...args, type: initial.account.type, sourceId: args.id },
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  const identityProof =
    !args.disconnectAll &&
    initial.account.type === CLAUDE_CODE_TYPE &&
    isFeatureEnabled(
      FeatureSwitchKey.PersonalSubscriptionPriority,
      args.featureSwitchContext,
    )
      ? await prepareClaudeAccountIdentities(
          { ...args, type: initial.account.type },
          signal,
        )
      : null;
  const result = await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: initial.account.type,
    });
    if (
      !args.disconnectAll &&
      !(await reconcileLockedPersonalSubscriptionCredentials({
        ...args,
        db: tx,
        type: initial.account.type as PersonalSubscriptionProviderType,
        sourceId: args.id,
      }))
    ) {
      return notFound("Resource not found");
    }
    if (identityProof) {
      const snapshot = await lockSubscriptionCredentialSnapshot({
        ...args,
        db: tx,
        type: CLAUDE_CODE_TYPE,
      });
      if (
        !snapshot ||
        JSON.stringify(snapshot) !== JSON.stringify(identityProof.snapshot)
      ) {
        return notFound("Resource not found");
      }
      await applyClaudeIdentityProof(tx, snapshot.accounts, identityProof);
    }
    const current = await accountWithProvider(tx, args);
    if (!current) {
      return notFound("Resource not found");
    }
    const retain = isFeatureEnabled(
      FeatureSwitchKey.PersonalSubscriptionPriority,
      args.featureSwitchContext,
    );
    await retirePersonalModelProviderAccount(tx, current.account, retain);
    const [replacement] = await tx
      .select()
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.modelProviderId, current.provider.id),
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      )
      .orderBy(
        asc(modelProviderAccounts.needsReconnect),
        asc(modelProviderAccounts.createdAt),
        asc(modelProviderAccounts.id),
      )
      .limit(1);
    if (!replacement) {
      await deleteLastAccount(tx, current);
      return undefined;
    }
    if (current.account.isActive) {
      const [active] = await tx
        .update(modelProviderAccounts)
        .set({ isActive: true, updatedAt: nowDate() })
        .where(eq(modelProviderAccounts.id, replacement.id))
        .returning();
      if (!active) {
        throw new Error(
          "Expected replacement model provider account to return",
        );
      }
      await mirrorAccountToLegacy(tx, {
        account: active,
        provider: current.provider,
      });
    }
    return undefined;
  });
  // Disconnect-all is nested in the provider transaction; its owner publishes.
  if (result === undefined && !args.disconnectAll) {
    await publishPersonalModelProvidersChangedSafely(args.userId);
  }
  return result;
}

export async function activePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly modelProviderId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<AccountRow | null> {
  const [account] = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.modelProviderId, args.modelProviderId),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.isActive, true),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    )
    .limit(1);
  return account ?? null;
}

/**
 * Capture the concrete subscription account selected for one run admission.
 *
 * A non-null candidate can name either the logical provider row or an already
 * captured account row. Unknown/stale explicit IDs fail closed instead of
 * falling back to whichever sibling account is active.
 */
export async function captureActivePersonalModelProviderAccount(
  args: {
    readonly db: Db;
    readonly type: PersonalSubscriptionProviderType;
    readonly orgId: string;
    readonly userId: string;
    readonly modelProviderId: string | null;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal?: AbortSignal,
): Promise<AccountRow | null> {
  if (args.modelProviderId !== null) {
    const exactAccount = await personalModelProviderAccountById({
      db: args.db,
      id: args.modelProviderId,
      orgId: args.orgId,
      userId: args.userId,
    });
    if (exactAccount) {
      if (
        exactAccount.type !== args.type ||
        !(await coordinatePersonalSubscriptionCredentials(
          {
            ...args,
            sourceId: exactAccount.id,
          },
          signal,
        ))
      ) {
        return null;
      }
      return await personalModelProviderAccountById({
        ...args,
        id: exactAccount.id,
      });
    }
  }

  const [provider] = await args.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, args.userId),
        eq(modelProviders.type, args.type),
        ...(args.modelProviderId === null
          ? []
          : [eq(modelProviders.id, args.modelProviderId)]),
      ),
    )
    .limit(1);
  if (!provider) {
    return null;
  }
  const ready = await ensurePersonalModelProviderAccount(
    {
      db: args.db,
      provider,
      featureSwitchContext: args.featureSwitchContext,
    },
    signal,
  );
  if (!ready) {
    return null;
  }
  const account = await activePersonalModelProviderAccount({
    db: args.db,
    modelProviderId: provider.id,
    orgId: args.orgId,
    userId: args.userId,
  });
  return account?.type === args.type ? account : null;
}

export async function personalModelProviderAccountById(args: {
  readonly db: Db;
  readonly runId?: string;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<AccountRow | null> {
  const [account] = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.id, args.id),
        personalSubscriptionAccountAccessCondition(args.db, args.runId),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
      ),
    )
    .limit(1);
  return account ?? null;
}

/** Exact management reads never enumerate, seed, or substitute a sibling. */
export async function personalModelProviderAccountResponseById(args: {
  readonly db: Db;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ModelProviderResponse | null> {
  const row = await accountWithProvider(args.db, args);
  return row && isPersonalSubscriptionProviderType(row.account.type)
    ? accountResponse(row)
    : null;
}

/** Settings never receive retired credentials. Runtime retention requires the
 * exact owner, org and live run binding, including queued work. */
export function personalSubscriptionAccountAccessCondition(
  db: ReadonlyDb,
  runId?: string,
) {
  const connected = isNull(modelProviderAccounts.disconnectedAt);
  return runId === undefined
    ? connected
    : or(
        connected,
        exists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, runId),
                eq(agentRuns.orgId, modelProviderAccounts.orgId),
                eq(agentRuns.userId, modelProviderAccounts.userId),
                eq(agentRuns.modelProviderId, modelProviderAccounts.id),
                inArray(agentRuns.status, ["queued", "pending", "running"]),
              ),
            ),
        ),
      );
}

export function visiblePersonalModelProviderCondition(db: ReadonlyDb) {
  return or(
    notExists(
      db
        .select({ id: modelProviderAccounts.id })
        .from(modelProviderAccounts)
        .where(eq(modelProviderAccounts.modelProviderId, modelProviders.id)),
    ),
    exists(
      db
        .select({ id: modelProviderAccounts.id })
        .from(modelProviderAccounts)
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, modelProviders.id),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        ),
    ),
  );
}

async function retirePersonalModelProviderAccount(
  db: Db,
  account: AccountRow,
  retain: boolean,
): Promise<void> {
  const [reference] = retain
    ? await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.modelProviderId, account.id),
            eq(agentRuns.orgId, account.orgId),
            eq(agentRuns.userId, account.userId),
            inArray(agentRuns.status, ["queued", "pending", "running"]),
          ),
        )
        .limit(1)
    : [];
  if (reference) {
    await db
      .update(modelProviderAccounts)
      .set({ isActive: false, disconnectedAt: nowDate(), updatedAt: nowDate() })
      .where(eq(modelProviderAccounts.id, account.id));
  } else {
    await db
      .delete(modelProviderAccounts)
      .where(eq(modelProviderAccounts.id, account.id));
  }
}

async function applyStableAccountMutation(
  db: Db,
  args: Parameters<typeof applyAccountMutation>[1],
  target: AccountRow | null,
): Promise<Awaited<ReturnType<typeof applyAccountMutation>>> {
  // Reconnecting to another upstream identity selects its existing row (even a
  // retained row), never overwrites the identity of the requested account.
  const selected =
    args.accounts.find((account) => {
      return identityMatches(account, args.type, args.metadata);
    }) ?? null;
  const connected = args.accounts.filter((account) => {
    return account.disconnectedAt === null;
  });
  const replacing =
    args.mode.kind !== "add" && target && target.id !== selected?.id;
  if (
    (!selected || selected.disconnectedAt !== null) &&
    connected.length - (replacing ? 1 : 0) >= MAX_PERSONAL_PROVIDER_ACCOUNTS
  ) {
    return badRequestMessage(
      `A maximum of ${MAX_PERSONAL_PROVIDER_ACCOUNTS} ${args.type} accounts can be connected`,
    );
  }
  const active =
    connected.length === 0 ||
    target?.isActive === true ||
    selected?.isActive === true;
  if (replacing) {
    await retirePersonalModelProviderAccount(db, target, args.retainReplaced);
  }
  if (active) {
    await db
      .update(modelProviderAccounts)
      .set({ isActive: false })
      .where(eq(modelProviderAccounts.modelProviderId, args.provider.id));
  }
  const values = {
    ...args.metadata,
    authMethod: args.authMethod,
    isActive: active,
    disconnectedAt: null,
  };
  const [account] = selected
    ? await db
        .update(modelProviderAccounts)
        .set(values)
        .where(eq(modelProviderAccounts.id, selected.id))
        .returning()
    : await db
        .insert(modelProviderAccounts)
        .values({
          ...values,
          modelProviderId: args.provider.id,
          orgId: args.provider.orgId,
          userId: args.provider.userId,
          type: args.type,
        })
        .returning();
  if (!account) {
    throw new Error("Expected subscription account mutation to return");
  }
  await replaceAccountSecrets(db, account.id, args.encryptedSecrets);
  if (active) {
    await mirrorAccountToLegacy(db, { account, provider: args.provider });
  }
  return { account, created: !selected };
}

/** Called inside the terminal transaction after the run update. The auth-state
 * lock serializes cleanup with admission, settings mutations and token refresh.
 * A second terminal transition observes the first commit and removes the final
 * reference; no wall-clock retention delay is used. */
export async function cleanupDisconnectedPersonalModelProviderAccounts(
  db: Db,
  runs: readonly {
    readonly orgId: string;
    readonly userId: string;
    readonly modelProviderId: string | null;
  }[],
): Promise<void> {
  const ids = [
    ...new Set(
      runs.flatMap((run) => {
        return run.modelProviderId ? [run.modelProviderId] : [];
      }),
    ),
  ];
  if (ids.length === 0) {
    return;
  }
  const accounts = await db
    .select()
    .from(modelProviderAccounts)
    .where(inArray(modelProviderAccounts.id, ids))
    .orderBy(
      modelProviderAccounts.orgId,
      modelProviderAccounts.userId,
      modelProviderAccounts.type,
      modelProviderAccounts.id,
    );
  for (const account of accounts) {
    await lockModelProviderState(db, account);
    // A fresh same-identity connection may have revived the row while waiting.
    const [current] = await db
      .select()
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.id, account.id),
          isNotNull(modelProviderAccounts.disconnectedAt),
        ),
      )
      .limit(1);
    if (!current) {
      continue;
    }
    await retirePersonalModelProviderAccount(db, current, true);
    const [remaining] = await db
      .select({ id: modelProviderAccounts.id })
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.modelProviderId, current.modelProviderId))
      .limit(1);
    if (!remaining) {
      await db
        .delete(modelProviders)
        .where(eq(modelProviders.id, current.modelProviderId));
    }
  }
}

interface SubscriptionCredentialOwner {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly sourceId?: string;
  readonly runId?: string;
}

/** A1 lifecycle rows -> provider advisory -> provider -> accounts -> secrets.
 * NO KEY UPDATE excludes the old Claude autocommit UPDATE without obstructing
 * its later provider INSERT's secret FK KEY SHARE. Never call identity HTTP under these
 * locks. All supported account writers mirror the active bundle atomically;
 * inactive writers do not mirror. See the writer audit in the identity guide. */
async function lockSubscriptionCredentialSnapshot(
  args: SubscriptionCredentialOwner,
) {
  const { db } = args;
  await lockModelProviderState(db, args);
  const [provider] = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, args.userId),
        eq(modelProviders.type, args.type),
      ),
    )
    .for("no key update");
  if (!provider) {
    return null;
  }
  const accounts = await db
    .select()
    .from(modelProviderAccounts)
    .where(eq(modelProviderAccounts.modelProviderId, provider.id))
    .orderBy(modelProviderAccounts.id)
    .for("no key update");
  const names =
    args.type === CLAUDE_CODE_TYPE
      ? ["CLAUDE_CODE_OAUTH_TOKEN"]
      : [
          "CHATGPT_ACCESS_TOKEN",
          "CHATGPT_REFRESH_TOKEN",
          "CHATGPT_ACCOUNT_ID",
          "CHATGPT_ID_TOKEN",
        ];
  const mirror = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.type, "model-provider"),
        inArray(secrets.name, names),
      ),
    )
    .orderBy(secrets.id)
    .for("no key update");
  const accountSecrets =
    accounts.length === 0
      ? []
      : await db
          .select()
          .from(modelProviderAccountSecrets)
          .where(
            inArray(
              modelProviderAccountSecrets.modelProviderAccountId,
              accounts.map((account) => {
                return account.id;
              }),
            ),
          )
          .orderBy(modelProviderAccountSecrets.id)
          .for("no key update");
  const active = accounts.find((account) => {
    return account.isActive && account.disconnectedAt === null;
  });
  return { provider, accounts, mirror, accountSecrets, active };
}

type SubscriptionCredentialSnapshot = NonNullable<
  Awaited<ReturnType<typeof lockSubscriptionCredentialSnapshot>>
>;

async function credentialValues(
  rows: readonly { readonly name: string; readonly encryptedValue: string }[],
  featureSwitchContext: FeatureSwitchContext,
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(
      row.name,
      await decryptStoredSecretValue(row.encryptedValue, featureSwitchContext),
    );
  }
  return values;
}

async function subscriptionBundlesMatch(
  snapshot: SubscriptionCredentialSnapshot,
  featureSwitchContext: FeatureSwitchContext,
): Promise<boolean> {
  const accountSecrets = snapshot.accountSecrets.filter((secret) => {
    return secret.modelProviderAccountId === snapshot.active?.id;
  });
  if (
    snapshot.mirror.length !== accountSecrets.length ||
    snapshot.mirror.length === 0
  ) {
    return false;
  }
  if (
    snapshot.provider.type === CLAUDE_CODE_TYPE &&
    snapshot.mirror[0]?.id !== snapshot.provider.secretId
  ) {
    return false;
  }
  if (snapshot.provider.authMethod !== snapshot.active?.authMethod) {
    return false;
  }
  const canonical = new Map(
    accountSecrets.map((secret) => {
      return [secret.name, secret.encryptedValue];
    }),
  );
  for (const secret of snapshot.mirror) {
    const encrypted = canonical.get(secret.name);
    if (encrypted === undefined) {
      return false;
    }
    // The bounded KMS rotation also rewrites these tables independently. Equal
    // plaintext is the same bundle, not evidence of a legacy credential write.
    if (
      encrypted !== secret.encryptedValue &&
      (await decryptStoredSecretValue(encrypted, featureSwitchContext)) !==
        (await decryptStoredSecretValue(
          secret.encryptedValue,
          featureSwitchContext,
        ))
    ) {
      return false;
    }
  }
  return true;
}

function snapshotNeedsCoordination(
  snapshot: SubscriptionCredentialSnapshot,
  sourceId?: string,
) {
  return (
    (snapshot.active !== undefined &&
      (sourceId === undefined || snapshot.active.id === sourceId)) ||
    (sourceId === undefined &&
      snapshot.accounts.length > 0 &&
      snapshot.accounts.every((account) => {
        return account.disconnectedAt !== null;
      }) &&
      snapshot.mirror.length > 0)
  );
}

async function reconcileCodexRefreshMetadata(
  db: Db,
  snapshot: SubscriptionCredentialSnapshot,
) {
  const { active, provider } = snapshot;
  if (
    !active ||
    provider.type !== CODEX_TYPE ||
    (active.tokenExpiresAt?.getTime() === provider.tokenExpiresAt?.getTime() &&
      active.needsReconnect === provider.needsReconnect &&
      active.lastRefreshErrorCode === provider.lastRefreshErrorCode)
  ) {
    return;
  }
  // Old Codex failure writes change only provider state under this same lock.
  // Claude's uncoordinated late metadata has no such authority.
  await db
    .update(modelProviderAccounts)
    .set({
      tokenExpiresAt: provider.tokenExpiresAt,
      needsReconnect: provider.needsReconnect,
      lastRefreshErrorCode: provider.lastRefreshErrorCode,
      updatedAt: nowDate(),
    })
    .where(eq(modelProviderAccounts.id, active.id));
}

async function importLegacySubscriptionBundle(
  args: SubscriptionCredentialOwner,
  snapshot: SubscriptionCredentialSnapshot,
  metadata: PersonalProviderAccountMetadata,
  oldIdentity?: PersonalProviderAccountMetadata,
): Promise<boolean> {
  const active = snapshot.active;
  if (oldIdentity && active) {
    await args.db
      .update(modelProviderAccounts)
      .set({
        externalAccountId: oldIdentity.externalAccountId ?? null,
        accountEmail: oldIdentity.accountEmail ?? null,
        workspaceName: oldIdentity.workspaceName ?? null,
      })
      .where(eq(modelProviderAccounts.id, active.id));
  }
  const accounts = snapshot.accounts.map((account) => {
    return account.id === active?.id && oldIdentity
      ? {
          ...account,
          externalAccountId: oldIdentity.externalAccountId ?? null,
          accountEmail: oldIdentity.accountEmail ?? null,
          workspaceName: oldIdentity.workspaceName ?? null,
        }
      : account;
  });
  const values = await credentialValues(
    snapshot.mirror,
    args.featureSwitchContext,
  );
  if (args.type === CODEX_TYPE) {
    for (const name of [
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
    ]) {
      if (!values.get(name)?.trim()) {
        return false;
      }
    }
  }
  const mutation = {
    accounts,
    type: args.type,
    mode: { kind: "replace-active" as const },
    metadata: accountMetadataValues({
      type: args.type,
      metadata,
      secretValues: Object.fromEntries(values),
    }),
  };
  const expiryBindings = affectedCodexExpiryBindings(mutation);
  const invalidateExpiry = () => {
    for (const binding of expiryBindings) {
      invalidateCodexResetCreditExpiry(
        { scope: "personal", orgId: args.orgId, userId: args.userId },
        { binding },
      );
    }
  };
  invalidateExpiry();
  const result = await applyAccountMutation(args.db, {
    ...mutation,
    provider: snapshot.provider,
    authMethod: snapshot.provider.authMethod,
    encryptedSecrets: snapshot.mirror.map((secret) => {
      return {
        ...secret,
        description:
          secret.description ?? `Personal ${args.type} account secret`,
      };
    }),
    retainReplaced: isFeatureEnabled(
      FeatureSwitchKey.PersonalSubscriptionPriority,
      args.featureSwitchContext,
    ),
  });
  if ("status" in result) {
    return false;
  }
  if (args.type === CODEX_TYPE) {
    await args.db
      .update(modelProviderAccounts)
      .set({
        needsReconnect: snapshot.provider.needsReconnect,
        lastRefreshErrorCode: snapshot.provider.lastRefreshErrorCode,
      })
      .where(eq(modelProviderAccounts.id, result.account.id));
    await args.db
      .update(modelProviders)
      .set({
        needsReconnect: snapshot.provider.needsReconnect,
        lastRefreshErrorCode: snapshot.provider.lastRefreshErrorCode,
      })
      .where(eq(modelProviders.id, snapshot.provider.id));
  }
  invalidateExpiry();
  return true;
}

async function reconcileLockedSubscriptionSnapshot(
  args: SubscriptionCredentialOwner,
  snapshot: SubscriptionCredentialSnapshot,
): Promise<boolean> {
  if (!snapshotNeedsCoordination(snapshot, args.sourceId)) {
    return true;
  }
  if (await subscriptionBundlesMatch(snapshot, args.featureSwitchContext)) {
    await reconcileCodexRefreshMetadata(args.db, snapshot);
    return true;
  }
  if (args.type !== CODEX_TYPE) {
    return false;
  }
  const values = await credentialValues(
    snapshot.mirror,
    args.featureSwitchContext,
  );
  const oldValues = await credentialValues(
    snapshot.accountSecrets.filter((secret) => {
      return secret.modelProviderAccountId === snapshot.active?.id;
    }),
    args.featureSwitchContext,
  );
  const oldAccountId = oldValues.get(CODEX_ACCOUNT_ID_SECRET);
  if (snapshot.active && !oldAccountId) {
    return false;
  }
  return await importLegacySubscriptionBundle(
    args,
    snapshot,
    {
      externalAccountId: values.get(CODEX_ACCOUNT_ID_SECRET),
      accountEmail: extractCodexAccountEmailFromIdToken(
        values.get(CODEX_ID_TOKEN_SECRET),
      ),
      tokenExpiresAt: snapshot.provider.tokenExpiresAt,
      workspaceName: snapshot.provider.workspaceName,
      planType: snapshot.provider.planType,
      subscriptionResetPeriod: snapshot.provider.subscriptionResetPeriod,
      subscriptionNextResetAt: snapshot.provider.subscriptionNextResetAt,
    },
    snapshot.active
      ? {
          externalAccountId: oldAccountId,
          accountEmail: snapshot.active.accountEmail,
          workspaceName: snapshot.active.workspaceName,
        }
      : undefined,
  );
}

/** Refresh and settings mutations own their provider transaction. This helper
 * can decrypt through KMS; final admission must use its database-only validator. */
export async function reconcileLockedPersonalSubscriptionCredentials(
  args: SubscriptionCredentialOwner,
): Promise<boolean> {
  const snapshot = await lockSubscriptionCredentialSnapshot(args);
  return (
    snapshot !== null &&
    (await reconcileLockedSubscriptionSnapshot(args, snapshot))
  );
}

export interface PreparedPersonalSubscriptionAdmission {
  readonly sourceId: string;
  readonly snapshot: string;
}

/** Capture only encrypted state under the provider/credential locks, then
 * release them before proving complete plaintext equivalence (KMS rotation can
 * encrypt the two stores independently). Earlier capture/environment preparation
 * owns legacy identity import; a mismatch here rejects that fixed capture.
 * This proof is operation-local and never enters a persisted run/queue payload. */
export async function preparePersonalSubscriptionAdmission(
  args: SubscriptionCredentialOwner & { readonly sourceId: string },
  signal: AbortSignal,
): Promise<PreparedPersonalSubscriptionAdmission | null> {
  const snapshot = await args.db.transaction(async (tx) => {
    return await lockSubscriptionCredentialSnapshot({ ...args, db: tx });
  });
  signal.throwIfAborted();
  if (!snapshot) {
    return null;
  }
  const coherent =
    !snapshotNeedsCoordination(snapshot, args.sourceId) ||
    (await subscriptionBundlesMatch(snapshot, args.featureSwitchContext));
  signal.throwIfAborted();
  return coherent
    ? { sourceId: args.sourceId, snapshot: JSON.stringify(snapshot) }
    : null;
}

/** Called after the existing lifecycle fences, in the run-insert transaction.
 * Compare every row ID, identity, selection, state and encrypted cell without
 * decryption or legacy import. A winning writer invalidates this proof even if
 * its new ciphertext might decrypt to the same bytes. A new request can prepare
 * that new snapshot outside the locks; this admission never reselects. */
export async function validatePersonalSubscriptionAdmission(
  args: SubscriptionCredentialOwner,
  prepared: PreparedPersonalSubscriptionAdmission | null,
): Promise<boolean> {
  if (!prepared || prepared.sourceId !== args.sourceId) {
    return false;
  }
  const snapshot = await lockSubscriptionCredentialSnapshot(args);
  if (!snapshot || JSON.stringify(snapshot) !== prepared.snapshot) {
    return false;
  }
  if (snapshotNeedsCoordination(snapshot, args.sourceId)) {
    await reconcileCodexRefreshMetadata(args.db, snapshot);
  }
  return true;
}

function hasClaudeIdentity(identity: PersonalProviderAccountMetadata): boolean {
  return Boolean(
    identity.externalAccountId ||
    (identity.accountEmail && identity.workspaceName),
  );
}

async function previousClaudeIdentityProof(
  active: AccountRow | undefined,
  oldToken: string | null,
  signal: AbortSignal,
) {
  if (!active || hasClaudeIdentity(active)) {
    return { ok: true as const, value: active };
  }
  return oldToken
    ? await settle(
        fetchClaudeCodeProfileMetadata({ accessToken: oldToken }, signal),
      )
    : { ok: false as const };
}

/** Request-scoped rollout bridge for actual 1.595.0 singleton writers. Remove
 * under #34010 only after serving writers, old contexts and the executable
 * rollback floor have closed the documented compatibility window. */
export async function coordinatePersonalSubscriptionCredentials(
  args: SubscriptionCredentialOwner,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<boolean> {
  const observed = await args.db.transaction(async (tx) => {
    const snapshot = await lockSubscriptionCredentialSnapshot({
      ...args,
      db: tx,
    });
    if (!snapshot) {
      return { ready: false, snapshot: null };
    }
    const ready = await reconcileLockedSubscriptionSnapshot(
      { ...args, db: tx },
      snapshot,
    );
    return { ready, snapshot };
  });
  signal.throwIfAborted();
  if (observed.ready || !observed.snapshot || args.type !== CLAUDE_CODE_TYPE) {
    return observed.ready;
  }
  const snapshot = observed.snapshot;
  const active = snapshot.active;
  const legacy = snapshot.mirror.find((secret) => {
    return secret.id === snapshot.provider.secretId;
  });
  const previous = snapshot.accountSecrets.find((secret) => {
    return (
      secret.modelProviderAccountId === active?.id &&
      secret.name === "CLAUDE_CODE_OAUTH_TOKEN"
    );
  });
  if (!legacy || (active && !previous) || snapshot.mirror.length !== 1) {
    return false;
  }
  const token = await decryptStoredSecretValue(
    legacy.encryptedValue,
    args.featureSwitchContext,
  );
  const oldToken = previous
    ? await decryptStoredSecretValue(
        previous.encryptedValue,
        args.featureSwitchContext,
      )
    : null;
  signal.throwIfAborted();
  const [currentProof, oldProof] = await Promise.all([
    settle(fetchClaudeCodeProfileMetadata({ accessToken: token }, signal)),
    previousClaudeIdentityProof(active, oldToken, signal),
  ]);
  signal.throwIfAborted();
  if (
    !currentProof.ok ||
    !hasClaudeIdentity(currentProof.value) ||
    !oldProof.ok ||
    (active && (!oldProof.value || !hasClaudeIdentity(oldProof.value)))
  ) {
    return false;
  }
  return await args.db.transaction(async (tx) => {
    const current = await lockSubscriptionCredentialSnapshot({
      ...args,
      db: tx,
    });
    signal.throwIfAborted();
    // Includes row IDs, complete ciphertext bundles, active selection, provider
    // pointer/state and stored identity. Timestamps are equality fences only.
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      return false;
    }
    return await importLegacySubscriptionBundle(
      { ...args, db: tx },
      snapshot,
      currentProof.value,
      oldProof.value,
    );
  });
}

export async function ensurePersonalModelProviderAccount(
  args: {
    readonly db: Db;
    readonly provider: ProviderRow;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  await seedPersonalModelProviderAccount(args);
  if (!isPersonalSubscriptionProviderType(args.provider.type)) {
    return true;
  }
  return await coordinatePersonalSubscriptionCredentials(
    { ...args, ...args.provider, type: args.provider.type },
    signal,
  );
}

/** Returns state and the complete credential bundle from one locked snapshot.
 * Exact inactive/retained credentials are never reconciled from the mirror. */
export async function readPersonalSubscriptionCredentialBundle(
  args: SubscriptionCredentialOwner,
  signal?: AbortSignal,
) {
  const current = await readLockedPersonalSubscriptionBundle(args);
  if (current !== false) {
    return current;
  }
  // Only an opaque identity mismatch needs an unlocked profile round trip.
  // Coherent bundles and locked Codex imports are already one atomic read.
  if (!(await coordinatePersonalSubscriptionCredentials(args, signal))) {
    return null;
  }
  const coordinated = await readLockedPersonalSubscriptionBundle(args);
  return coordinated === false ? null : coordinated;
}

async function readLockedPersonalSubscriptionBundle(
  args: SubscriptionCredentialOwner,
) {
  return await args.db.transaction(async (tx) => {
    const snapshot = await lockSubscriptionCredentialSnapshot({
      ...args,
      db: tx,
    });
    if (!snapshot) {
      return null;
    }
    const needsCoordination = snapshotNeedsCoordination(
      snapshot,
      args.sourceId,
    );
    const coherent =
      !needsCoordination ||
      (await subscriptionBundlesMatch(snapshot, args.featureSwitchContext));
    if (coherent) {
      if (needsCoordination) {
        await reconcileCodexRefreshMetadata(tx, snapshot);
      }
      const account = snapshot.accounts.find((candidate) => {
        return (
          candidate.orgId === args.orgId &&
          candidate.userId === args.userId &&
          candidate.type === args.type &&
          candidate.disconnectedAt === null &&
          (args.sourceId ? candidate.id === args.sourceId : candidate.isActive)
        );
      });
      if (account) {
        const rows = snapshot.accountSecrets.filter((secret) => {
          return secret.modelProviderAccountId === account.id;
        });
        return {
          account:
            args.type === CODEX_TYPE && account.id === snapshot.active?.id
              ? {
                  ...account,
                  tokenExpiresAt: snapshot.provider.tokenExpiresAt,
                  needsReconnect: snapshot.provider.needsReconnect,
                  lastRefreshErrorCode: snapshot.provider.lastRefreshErrorCode,
                }
              : account,
          values: await credentialValues(rows, args.featureSwitchContext),
        };
      }
    } else if (
      !(await reconcileLockedSubscriptionSnapshot(
        { ...args, db: tx },
        snapshot,
      ))
    ) {
      return false as const;
    }
    const [account] = await tx
      .select()
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(modelProviderAccounts.userId, args.userId),
          eq(modelProviderAccounts.type, args.type),
          ...(args.sourceId
            ? [eq(modelProviderAccounts.id, args.sourceId)]
            : [eq(modelProviderAccounts.isActive, true)]),
          personalSubscriptionAccountAccessCondition(tx, args.runId),
        ),
      );
    if (!account) {
      if (args.sourceId) {
        return null;
      }
      const [provider] = await tx
        .select()
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.type, args.type),
          ),
        );
      return provider
        ? {
            account: provider,
            values: await credentialValues(
              await legacySecretRows(tx, provider),
              args.featureSwitchContext,
            ),
          }
        : null;
    }
    const rows = await tx
      .select()
      .from(modelProviderAccountSecrets)
      .where(
        eq(modelProviderAccountSecrets.modelProviderAccountId, account.id),
      );
    return {
      account,
      values: await credentialValues(rows, args.featureSwitchContext),
    };
  });
}
