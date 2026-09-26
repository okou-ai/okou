import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
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
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { settle } from "../utils";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { publishPersonalModelProvidersChangedSafely } from "../external/realtime";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { invalidateCodexResetCreditExpiry } from "./codex-reset-credit-expiry.service";
import { fetchClaudeCodeProfileMetadata } from "./claude-code-usage.service";

const MAX_PERSONAL_PROVIDER_ACCOUNTS = 10;
const CODEX_TYPE = "codex-oauth-token";
const CLAUDE_CODE_TYPE = "claude-code-oauth-token";
const CODEX_ACCOUNT_ID_SECRET = "CHATGPT_ACCOUNT_ID";
const ORG_SENTINEL_USER_ID = "__org__";
const ACCOUNT_CONFLICT_MESSAGE =
  "The subscription account changed concurrently. Refresh and try again.";

export type PersonalSubscriptionProviderType =
  | typeof CODEX_TYPE
  | typeof CLAUDE_CODE_TYPE;

/** Request-local identity selected at capture. Mutable account and credential
 * state must still be read again from the account tables before use. */
export interface CapturedPersonalSubscriptionAccount {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
}

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
  | ReturnType<typeof notFound>
  | ReturnType<typeof conflict>;

/** Account writers rely on constraints instead of locks: one active account per
 * provider, one row per upstream identity and one secret per name. A losing
 * concurrent writer surfaces as an explicit conflict. */
async function withAccountConflict<T>(
  write: () => Promise<T>,
): Promise<T | ReturnType<typeof conflict>> {
  const result = await settle(write());
  if (result.ok) {
    return result.value;
  }
  if (isUniqueViolation(result.error)) {
    return conflict(ACCOUNT_CONFLICT_MESSAGE);
  }
  throw result.error;
}

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

async function upsertAccountSecrets(
  db: Db,
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
): Promise<void> {
  if (encryptedSecrets.length > 0) {
    await db
      .insert(modelProviderAccountSecrets)
      .values(
        encryptedSecrets.map((secret) => {
          return { modelProviderAccountId: accountId, ...secret };
        }),
      )
      .onConflictDoUpdate({
        target: [
          modelProviderAccountSecrets.modelProviderAccountId,
          modelProviderAccountSecrets.name,
        ],
        set: {
          encryptedValue: sql`excluded.encrypted_value`,
          description: sql`excluded.description`,
          updatedAt: nowDate(),
        },
      });
  }
  await db.delete(modelProviderAccountSecrets).where(
    and(
      eq(modelProviderAccountSecrets.modelProviderAccountId, accountId),
      ...(encryptedSecrets.length === 0
        ? []
        : [
            not(
              inArray(
                modelProviderAccountSecrets.name,
                encryptedSecrets.map((secret) => {
                  return secret.name;
                }),
              ),
            ),
          ]),
    ),
  );
}

export async function listPersonalModelProviderAccounts(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ModelProviderListResponse> {
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
      return accountResponse(row);
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

/** The `(org_id, user_id, type)` unique index owns concurrent first connects. */
async function logicalProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly selectedModel: string | undefined;
  },
): Promise<ProviderRow> {
  await db
    .insert(modelProviders)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      isDefault: false,
      selectedModel: args.selectedModel ?? null,
    })
    .onConflictDoNothing({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
    });
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
    .limit(1);
  if (!provider) {
    throw new Error("Expected logical model provider row");
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
  // Reconnecting to another upstream identity selects its existing row (even a
  // retained row), never overwrites the identity of the requested account.
  const selected =
    args.accounts.find((account) => {
      return identityMatches(account, args.type, args.metadata);
    }) ?? null;
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
    await retirePersonalModelProviderAccount(db, target);
  }
  if (active) {
    await db
      .update(modelProviderAccounts)
      .set({ isActive: false })
      .where(
        and(
          eq(modelProviderAccounts.modelProviderId, args.provider.id),
          eq(modelProviderAccounts.isActive, true),
          ...(selected ? [ne(modelProviderAccounts.id, selected.id)] : []),
        ),
      );
  }
  const values = {
    ...args.metadata,
    authMethod: args.authMethod,
    isActive: active,
    disconnectedAt: null,
  };
  // The provider/identity unique index merges a concurrent same-identity
  // connection into one row instead of inserting a duplicate.
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
        .onConflictDoUpdate({
          target: [
            modelProviderAccounts.modelProviderId,
            modelProviderAccounts.externalAccountId,
          ],
          set: {
            ...values,
            isActive: sql`${modelProviderAccounts.isActive} OR excluded.is_active`,
          },
        })
        .returning();
  if (!account) {
    throw new Error("Expected subscription account mutation to return");
  }
  await upsertAccountSecrets(db, account.id, args.encryptedSecrets);
  return { account, created: !selected };
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
  | PersonalProviderAccountErrorResponse
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

export async function upsertPersonalModelProviderAccount(
  args: UpsertPersonalAccountArgs,
  signal: AbortSignal,
): Promise<UpsertPersonalAccountResult> {
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
  const identityProof =
    args.type === CLAUDE_CODE_TYPE
      ? await prepareClaudeAccountIdentities(args, signal)
      : null;
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
  const result = await withAccountConflict(() => {
    return args.db.transaction(async (tx) => {
      const provider = await logicalProvider(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        selectedModel: args.selectedModel,
      });
      signal.throwIfAborted();
      const accounts = await applyClaudeIdentityProof(
        tx,
        await tx
          .select()
          .from(modelProviderAccounts)
          .where(eq(modelProviderAccounts.modelProviderId, provider.id))
          .orderBy(modelProviderAccounts.id),
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
      const mutation = await applyAccountMutation(tx, {
        provider,
        accounts,
        type: args.type,
        authMethod: args.authMethod,
        mode: args.mode,
        metadata,
        encryptedSecrets,
      });
      if ("status" in mutation) {
        return mutation;
      }
      return {
        provider: accountResponse({
          account: mutation.account,
          provider: await persistSubscriptionSelectedModel(tx, provider, args),
        }),
        created: mutation.created,
      };
    });
  }).finally(invalidateExpiry);
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

function hasClaudeIdentity(identity: PersonalProviderAccountMetadata): boolean {
  return Boolean(
    identity.externalAccountId ||
    (identity.accountEmail && identity.workspaceName),
  );
}

/** Profile identity for older Claude accounts is fetched outside any
 * transaction and recorded only while the row still lacks an identity. */
async function prepareClaudeAccountIdentities(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PersonalProviderAccountMetadata> | null> {
  const rows = await args.db
    .select({
      account: modelProviderAccounts,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
    })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviderAccountSecrets,
      eq(
        modelProviderAccountSecrets.modelProviderAccountId,
        modelProviderAccounts.id,
      ),
    )
    .where(
      and(
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.type, CLAUDE_CODE_TYPE),
        isNull(modelProviderAccounts.disconnectedAt),
        eq(modelProviderAccountSecrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
      ),
    );
  const identities = new Map<string, PersonalProviderAccountMetadata>();
  for (const row of rows) {
    if (hasClaudeIdentity(row.account)) {
      continue;
    }
    const accessToken = await decryptStoredSecretValue(
      row.encryptedValue,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    const result = await settle(
      fetchClaudeCodeProfileMetadata({ accessToken }, signal),
    );
    signal.throwIfAborted();
    if (result.ok && hasClaudeIdentity(result.value)) {
      identities.set(row.account.id, result.value);
    }
  }
  return identities.size === 0 ? null : identities;
}

/** Identify legacy Claude accounts before the all-account disconnect so a
 * retained row can still be matched by a later reconnect. */
export async function identifyPersonalSubscriptionAccountsBeforeDisconnect(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
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
  const accounts = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(inArray(modelProviderAccounts.id, [...proof.keys()]));
  await withAccountConflict(() => {
    return applyClaudeIdentityProof(args.db, accounts, proof);
  });
}

async function applyClaudeIdentityProof(
  db: Db,
  accounts: readonly AccountRow[],
  proof: ReadonlyMap<string, PersonalProviderAccountMetadata> | null,
): Promise<readonly AccountRow[]> {
  const hydrated: AccountRow[] = [];
  for (const account of accounts) {
    const metadata = proof?.get(account.id);
    if (!metadata || hasClaudeIdentity(account)) {
      hydrated.push(account);
      continue;
    }
    const [updated] = await db
      .update(modelProviderAccounts)
      .set({
        externalAccountId: metadata.externalAccountId ?? null,
        accountEmail: metadata.accountEmail ?? null,
        workspaceName: metadata.workspaceName ?? null,
      })
      .where(
        and(
          eq(modelProviderAccounts.id, account.id),
          isNull(modelProviderAccounts.externalAccountId),
          or(
            isNull(modelProviderAccounts.accountEmail),
            isNull(modelProviderAccounts.workspaceName),
          ),
        ),
      )
      .returning();
    hydrated.push(updated ?? account);
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

export async function activatePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly id: string;
}): Promise<
  | ModelProviderResponse
  | ReturnType<typeof notFound>
  | ReturnType<typeof conflict>
> {
  const result = await withAccountConflict(() => {
    return args.db.transaction(async (tx) => {
      const current = await accountWithProvider(tx, args);
      if (
        !current ||
        !isPersonalSubscriptionProviderType(current.account.type)
      ) {
        return notFound("Resource not found");
      }
      await tx
        .update(modelProviderAccounts)
        .set({ isActive: false, updatedAt: nowDate() })
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, current.provider.id),
            eq(modelProviderAccounts.isActive, true),
            ne(modelProviderAccounts.id, current.account.id),
          ),
        );
      // The one-active partial unique index rejects a concurrent activation.
      const [account] = await tx
        .update(modelProviderAccounts)
        .set({ isActive: true, updatedAt: nowDate() })
        .where(
          and(
            eq(modelProviderAccounts.id, current.account.id),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        )
        .returning();
      return account
        ? accountResponse({ account, provider: current.provider })
        : notFound("Resource not found");
    });
  });
  if (!("status" in result)) {
    await publishPersonalModelProvidersChangedSafely(args.userId);
  }
  return result;
}

/** Remove the logical provider once no account row, including a retained one,
 * still references it. */
async function deleteProviderWithoutAccounts(
  db: Db,
  providerId: string,
): Promise<void> {
  await db
    .delete(modelProviders)
    .where(
      and(
        eq(modelProviders.id, providerId),
        notExists(
          db
            .select({ id: modelProviderAccounts.id })
            .from(modelProviderAccounts)
            .where(eq(modelProviderAccounts.modelProviderId, providerId)),
        ),
      ),
    );
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
): Promise<
  ReturnType<typeof notFound> | ReturnType<typeof conflict> | undefined
> {
  const initial = await accountWithProvider(args.db, args);
  if (!initial || !isPersonalSubscriptionProviderType(initial.account.type)) {
    return notFound("Resource not found");
  }
  const identityProof =
    !args.disconnectAll && initial.account.type === CLAUDE_CODE_TYPE
      ? await prepareClaudeAccountIdentities(args, signal)
      : null;
  signal.throwIfAborted();
  const result = await withAccountConflict(() => {
    return args.db.transaction(async (tx) => {
      const current = await accountWithProvider(tx, args);
      if (!current) {
        return notFound("Resource not found");
      }
      const [account] = await applyClaudeIdentityProof(
        tx,
        [current.account],
        identityProof,
      );
      if (
        !account ||
        !(await retirePersonalModelProviderAccount(tx, account))
      ) {
        return notFound("Resource not found");
      }
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
        await deleteProviderWithoutAccounts(tx, current.provider.id);
        return undefined;
      }
      if (current.account.isActive) {
        await tx
          .update(modelProviderAccounts)
          .set({ isActive: true, updatedAt: nowDate() })
          .where(
            and(
              eq(modelProviderAccounts.id, replacement.id),
              isNull(modelProviderAccounts.disconnectedAt),
            ),
          );
      }
      return undefined;
    });
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
export async function captureActivePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly type: PersonalSubscriptionProviderType;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string | null;
}): Promise<AccountRow | null> {
  if (args.modelProviderId !== null) {
    const exactAccount = await personalModelProviderAccountById({
      db: args.db,
      id: args.modelProviderId,
      orgId: args.orgId,
      userId: args.userId,
    });
    if (exactAccount) {
      return exactAccount.type === args.type ? exactAccount : null;
    }
  }
  const [account] = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.type, args.type),
        eq(modelProviderAccounts.isActive, true),
        isNull(modelProviderAccounts.disconnectedAt),
        ...(args.modelProviderId === null
          ? []
          : [eq(modelProviderAccounts.modelProviderId, args.modelProviderId)]),
      ),
    )
    .limit(1);
  return account ?? null;
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

/** Retain a disconnected account while a live run still references it;
 * otherwise delete it. Returns false when a concurrent writer already
 * disconnected or removed the account. */
async function retirePersonalModelProviderAccount(
  db: Db,
  account: AccountRow,
): Promise<boolean> {
  const liveReference = exists(
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.modelProviderId, account.id),
          eq(agentRuns.orgId, account.orgId),
          eq(agentRuns.userId, account.userId),
          inArray(agentRuns.status, ["queued", "pending", "running"]),
        ),
      ),
  );
  const [retained] = await db
    .update(modelProviderAccounts)
    .set({ isActive: false, disconnectedAt: nowDate(), updatedAt: nowDate() })
    .where(
      and(
        eq(modelProviderAccounts.id, account.id),
        isNull(modelProviderAccounts.disconnectedAt),
        liveReference,
      ),
    )
    .returning({ id: modelProviderAccounts.id });
  if (retained) {
    return true;
  }
  const [deleted] = await db
    .delete(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.id, account.id),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    )
    .returning({ id: modelProviderAccounts.id });
  return deleted !== undefined;
}

/** Called inside the terminal transaction after the run update. A retained
 * account is deleted once no live run references it; a concurrent same-identity
 * reconnect that revived the row makes the conditional delete a no-op. */
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
  ].sort();
  if (ids.length === 0) {
    return;
  }
  const deleted = await db
    .delete(modelProviderAccounts)
    .where(
      and(
        inArray(modelProviderAccounts.id, ids),
        isNotNull(modelProviderAccounts.disconnectedAt),
        notExists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.modelProviderId, modelProviderAccounts.id),
                eq(agentRuns.orgId, modelProviderAccounts.orgId),
                eq(agentRuns.userId, modelProviderAccounts.userId),
                inArray(agentRuns.status, ["queued", "pending", "running"]),
              ),
            ),
        ),
      ),
    )
    .returning({ modelProviderId: modelProviderAccounts.modelProviderId });
  for (const providerId of new Set(
    deleted.map((row) => {
      return row.modelProviderId;
    }),
  )) {
    await deleteProviderWithoutAccounts(db, providerId);
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

/** One non-locking statement for the exact account and its whole ciphertext
 * bundle. Callers decrypt after it returns, never inside a transaction. */
async function readAccountCiphertexts(
  args: Omit<SubscriptionCredentialOwner, "featureSwitchContext"> & {
    readonly sourceId: string;
  },
): Promise<{
  readonly account: AccountRow;
  readonly secrets: readonly {
    readonly name: string;
    readonly encryptedValue: string;
  }[];
} | null> {
  const rows = await args.db
    .select({
      account: modelProviderAccounts,
      secret: {
        name: modelProviderAccountSecrets.name,
        encryptedValue: modelProviderAccountSecrets.encryptedValue,
      },
    })
    .from(modelProviderAccounts)
    .leftJoin(
      modelProviderAccountSecrets,
      eq(
        modelProviderAccountSecrets.modelProviderAccountId,
        modelProviderAccounts.id,
      ),
    )
    .where(
      and(
        eq(modelProviderAccounts.id, args.sourceId),
        personalSubscriptionAccountAccessCondition(args.db, args.runId),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.type, args.type),
      ),
    );
  const account = rows[0]?.account;
  return account
    ? {
        account,
        secrets: rows.flatMap((row) => {
          return row.secret ? [row.secret] : [];
        }),
      }
    : null;
}

/** Pi Codex first-turn fast path: copy only the access token and account ID
 * ciphertexts of a connected, healthy account. Callers check token freshness
 * before decrypting. */
export async function capturePiCodexCredentialCiphertexts(
  args: Omit<SubscriptionCredentialOwner, "type" | "featureSwitchContext"> & {
    readonly type: typeof CODEX_TYPE;
    readonly sourceId: string;
  },
): Promise<{
  readonly tokenExpiresAt: Date | null;
  readonly accessTokenCiphertext: string;
  readonly accountIdCiphertext: string;
} | null> {
  const current = await readAccountCiphertexts(args);
  if (
    !current ||
    current.account.disconnectedAt !== null ||
    current.account.needsReconnect
  ) {
    return null;
  }
  const byName = new Map(
    current.secrets.map((secret) => {
      return [secret.name, secret.encryptedValue] as const;
    }),
  );
  const accessTokenCiphertext = byName.get("CHATGPT_ACCESS_TOKEN");
  const accountIdCiphertext = byName.get(CODEX_ACCOUNT_ID_SECRET);
  return accessTokenCiphertext && accountIdCiphertext
    ? {
        tokenExpiresAt: current.account.tokenExpiresAt,
        accessTokenCiphertext,
        accountIdCiphertext,
      }
    : null;
}

async function credentialValues(
  rows: readonly { readonly name: string; readonly encryptedValue: string }[],
  featureSwitchContext: FeatureSwitchContext,
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  // Wait for every started decrypt, including on failure. Small batches bound
  // KMS fan-out per bundle without a cross-request queue or plaintext cache.
  for (let offset = 0; offset < rows.length; offset += 2) {
    const batch = await Promise.allSettled(
      rows.slice(offset, offset + 2).map(async (row) => {
        return [
          row.name,
          await decryptStoredSecretValue(
            row.encryptedValue,
            featureSwitchContext,
          ),
        ] as const;
      }),
    );
    for (const result of batch) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      values.set(...result.value);
    }
  }
  return values;
}

/** Run admission reads the captured account once, without locks. A concurrent
 * disconnect that commits afterwards fails the run through the explicit
 * subscription-unavailable path. */
export async function validatePersonalSubscriptionAdmission(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly sourceId: string | undefined;
}): Promise<AccountRow | null> {
  if (!args.sourceId) {
    return null;
  }
  const account = await personalModelProviderAccountById({
    db: args.db,
    id: args.sourceId,
    orgId: args.orgId,
    userId: args.userId,
  });
  return account?.type === args.type ? account : null;
}

/** Environment preparation reads the connected account, its logical provider
 * selection and its ciphertext bundle in one statement. */
export async function readPersonalSubscriptionAccount(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly sourceId: string;
}) {
  const rows = await args.db
    .select({
      account: modelProviderAccounts,
      selectedModel: modelProviders.selectedModel,
      secret: {
        name: modelProviderAccountSecrets.name,
        encryptedValue: modelProviderAccountSecrets.encryptedValue,
      },
    })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviders,
      eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    )
    .leftJoin(
      modelProviderAccountSecrets,
      eq(
        modelProviderAccountSecrets.modelProviderAccountId,
        modelProviderAccounts.id,
      ),
    )
    .where(
      and(
        eq(modelProviderAccounts.id, args.sourceId),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.type, args.type),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    );
  const first = rows[0];
  return first
    ? {
        account: first.account,
        selectedModel: first.selectedModel,
        secrets: rows.flatMap((row) => {
          return row.secret ? [row.secret] : [];
        }),
      }
    : null;
}

/** Organization subscriptions remain singleton `model_providers` + `secrets`
 * credentials. */
async function readOrgSubscriptionCredentialBundle(
  args: SubscriptionCredentialOwner,
) {
  const [provider] = await args.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, args.type),
      ),
    )
    .limit(1);
  if (!provider) {
    return null;
  }
  const names =
    (provider.authMethod
      ? getSecretNamesForAuthMethod(args.type, provider.authMethod)
      : undefined) ??
    [getSecretNameForType(args.type)].filter((name): name is string => {
      return name !== undefined;
    });
  const rows =
    names.length === 0
      ? []
      : await args.db
          .select({
            name: secrets.name,
            encryptedValue: secrets.encryptedValue,
          })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, args.orgId),
              eq(secrets.userId, ORG_SENTINEL_USER_ID),
              eq(secrets.type, "model-provider"),
              inArray(secrets.name, [...names]),
            ),
          );
  return {
    account: provider,
    values: await credentialValues(rows, args.featureSwitchContext),
  };
}

/** Returns state and the complete credential bundle of the exact personal
 * account. Personal subscriptions are addressed only by their account ID. */
export async function readPersonalSubscriptionCredentialBundle(
  args: SubscriptionCredentialOwner,
) {
  if (args.userId === ORG_SENTINEL_USER_ID) {
    return await readOrgSubscriptionCredentialBundle(args);
  }
  if (!args.sourceId) {
    return null;
  }
  const current = await readAccountCiphertexts({
    ...args,
    sourceId: args.sourceId,
  });
  return current
    ? {
        account: current.account,
        values: await credentialValues(
          current.secrets,
          args.featureSwitchContext,
        ),
      }
    : null;
}
