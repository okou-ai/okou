import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  not,
  or,
  sql,
  type SQL,
  notExists,
} from "drizzle-orm";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishPersonalModelProvidersChangedSafely } from "../external/realtime";
import { settle } from "../utils";
import { fetchClaudeCodeProfileMetadata } from "./claude-code-usage.service";
import { invalidateCodexResetCreditExpiry } from "./codex-reset-credit-expiry.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  deviceAuthSessionPublicationSql,
  type DeviceAuthSessionPublication,
} from "./model-provider-device-session-publication";

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

/** Connected Claude/Codex member accounts read together for one queued model route. */
export interface MemberModelAccountSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly accounts: readonly (typeof modelProviderAccounts.$inferSelect)[];
}

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

/** Account writers rely on existing unique indexes (one active account per
 * provider, one row per upstream identity). A violation surfaces as 409. */
async function withAccountConflict<T>(
  write: Promise<T>,
): Promise<T | ReturnType<typeof conflict>> {
  const result = await settle(write);
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

function planAccountMutation(args: {
  readonly accounts: readonly AccountRow[];
  readonly type: PersonalSubscriptionProviderType;
  readonly authMethod: string | null;
  readonly mode: PersonalProviderAccountMutation;
  readonly metadata: ReturnType<typeof accountMetadataValues>;
}) {
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
  return {
    selected,
    retiring: replacing ? target : null,
    values: {
      ...args.metadata,
      authMethod: args.authMethod,
      isActive: active,
      disconnectedAt: null,
    },
  };
}

function retiringAccountStatement(account: AccountRow) {
  const changedAt = nowDate();
  return sql`WITH retained AS (
    UPDATE ${modelProviderAccounts}
    SET is_active = false, disconnected_at = ${changedAt}, updated_at = ${changedAt}
    WHERE ${modelProviderAccounts.id} = ${account.id}
      AND ${modelProviderAccounts.disconnectedAt} IS NULL
      AND EXISTS (
        SELECT 1 FROM ${agentRuns}
        WHERE ${agentRuns.modelProviderId} = ${account.id}
          AND ${agentRuns.orgId} = ${account.orgId}
          AND ${agentRuns.userId} = ${account.userId}
          AND ${agentRuns.status} IN ('pending', 'running')
      )
    RETURNING id
  ) DELETE FROM ${modelProviderAccounts}
    WHERE ${modelProviderAccounts.id} = ${account.id}
      AND ${modelProviderAccounts.disconnectedAt} IS NULL
      AND NOT EXISTS (SELECT 1 FROM retained)`;
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
  readonly authSession?: DeviceAuthSessionPublication;
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

function invalidateAccountExpiry(
  args: { readonly orgId: string; readonly userId: string },
  bindings: ReadonlySet<string | null>,
) {
  for (const binding of bindings) {
    invalidateCodexResetCreditExpiry(
      { scope: "personal", orgId: args.orgId, userId: args.userId },
      { binding },
    );
  }
}

function accountSecretsPublicationStatement(
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
) {
  const owner = eq(
    modelProviderAccountSecrets.modelProviderAccountId,
    accountId,
  );
  if (encryptedSecrets.length === 0) {
    return sql`DELETE FROM ${modelProviderAccountSecrets} WHERE ${owner}`;
  }
  const rows = encryptedSecrets.map((secret) => {
    return sql`(${accountId}, ${secret.name}, ${secret.encryptedValue}, ${secret.description})`;
  });
  const names = encryptedSecrets.map((secret) => {
    return secret.name;
  });
  return sql`WITH upserted AS (
    INSERT INTO ${modelProviderAccountSecrets}
      (model_provider_account_id, name, encrypted_value, description)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (model_provider_account_id, name) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      description = excluded.description,
      updated_at = ${nowDate()}
    RETURNING name
  ) DELETE FROM ${modelProviderAccountSecrets}
    WHERE ${owner} AND ${not(inArray(modelProviderAccountSecrets.name, names))}`;
}

function connectedAccountCondition(providerId: string) {
  return and(
    eq(modelProviderAccounts.modelProviderId, providerId),
    isNull(modelProviderAccounts.disconnectedAt),
  );
}

async function logicalProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly selectedModel?: string;
  },
): Promise<ProviderRow> {
  const [existing] = await db
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
  if (existing) {
    return existing;
  }
  const [created] = await db
    .insert(modelProviders)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      isDefault: false,
      selectedModel: args.selectedModel ?? null,
    })
    .returning();
  if (!created) {
    throw new Error("Expected logical model provider row");
  }
  return created;
}

/** Record profile identity on older Claude accounts that still lack one. */
async function applyClaudeIdentities(
  db: Db,
  accounts: readonly AccountRow[],
  identities: ReadonlyMap<string, PersonalProviderAccountMetadata> | null,
): Promise<AccountRow[]> {
  const hydrated: AccountRow[] = [];
  for (const account of accounts) {
    const metadata = identities?.get(account.id);
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
      .where(eq(modelProviderAccounts.id, account.id))
      .returning();
    hydrated.push(updated ?? account);
  }
  return hydrated;
}

async function writePersonalAccount(
  db: Db,
  args: Omit<UpsertPersonalAccountArgs, "metadata"> & {
    readonly metadata: ReturnType<typeof accountMetadataValues>;
    readonly encryptedSecrets: readonly EncryptedAccountSecret[];
    readonly identities: ReadonlyMap<
      string,
      PersonalProviderAccountMetadata
    > | null;
  },
  expiryBindings: Set<string | null>,
): Promise<UpsertPersonalAccountResult> {
  return await db.transaction(async (tx) => {
    const provider = await logicalProvider(tx, args);
    const accounts = await applyClaudeIdentities(
      tx,
      await tx
        .select()
        .from(modelProviderAccounts)
        .where(eq(modelProviderAccounts.modelProviderId, provider.id))
        .orderBy(modelProviderAccounts.id),
      args.identities,
    );
    const plan = planAccountMutation({ ...args, accounts });
    if ("status" in plan) {
      return plan;
    }
    for (const binding of affectedCodexExpiryBindings({ ...args, accounts })) {
      expiryBindings.add(binding);
    }
    if (plan.retiring) {
      await tx.execute(retiringAccountStatement(plan.retiring));
    }
    if (plan.values.isActive) {
      await tx
        .update(modelProviderAccounts)
        .set({ isActive: false })
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, provider.id),
            eq(modelProviderAccounts.isActive, true),
            ...(plan.selected
              ? [ne(modelProviderAccounts.id, plan.selected.id)]
              : []),
          ),
        );
    }
    const [account] = plan.selected
      ? await tx
          .update(modelProviderAccounts)
          .set(plan.values)
          .where(eq(modelProviderAccounts.id, plan.selected.id))
          .returning()
      : await tx
          .insert(modelProviderAccounts)
          .values({
            ...plan.values,
            modelProviderId: provider.id,
            orgId: args.orgId,
            userId: args.userId,
            type: args.type,
          })
          .returning();
    if (!account) {
      throw new Error("Expected subscription account mutation to return");
    }
    await tx.execute(
      accountSecretsPublicationStatement(account.id, args.encryptedSecrets),
    );
    const selectedModel =
      args.mode.kind === "replace-active"
        ? (args.selectedModel ?? null)
        : provider.selectedModel;
    if (selectedModel !== provider.selectedModel) {
      await tx
        .update(modelProviders)
        .set({ selectedModel, updatedAt: nowDate() })
        .where(eq(modelProviders.id, provider.id));
    }
    const consent = deviceAuthSessionPublicationSql(args);
    if (consent && (await tx.execute(consent)).rowCount !== 1) {
      throw new Error("Device authorization was cancelled or expired");
    }
    return {
      provider: accountResponse({
        account,
        provider: { ...provider, selectedModel },
      }),
      created: !plan.selected,
    };
  });
}

export const upsertPersonalModelProviderAccount$ = command(
  async (
    { set },
    args: UpsertPersonalAccountArgs,
    signal: AbortSignal,
  ): Promise<UpsertPersonalAccountResult> => {
    const allowedNames = args.authMethod
      ? (getSecretNamesForAuthMethod(args.type, args.authMethod) ?? [])
      : [getSecretNameForType(args.type)];
    if (
      Object.keys(args.secretValues).some((name) => {
        return !allowedNames.includes(name);
      })
    ) {
      return badRequestMessage("Unsupported secrets for subscription account");
    }
    const metadata = await resolveConnectionIdentityMetadata(args, signal);
    signal.throwIfAborted();
    const encryptedSecrets = await encryptAccountSecrets(
      args.type,
      args.secretValues,
      args.featureSwitchContext,
      signal,
    );
    const db = set(writeDb$);
    const identities =
      args.type === CLAUDE_CODE_TYPE
        ? await prepareClaudeAccountIdentities(db, args, signal)
        : null;
    signal.throwIfAborted();
    const expiryBindings = new Set<string | null>();
    const result = await withAccountConflict(
      writePersonalAccount(
        db,
        {
          ...args,
          encryptedSecrets,
          identities,
          metadata: accountMetadataValues({
            type: args.type,
            metadata,
            secretValues: args.secretValues,
          }),
        },
        expiryBindings,
      ),
    ).finally(() => {
      invalidateAccountExpiry(args, expiryBindings);
    });
    signal.throwIfAborted();
    if (!("status" in result)) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

function hasClaudeIdentity(identity: PersonalProviderAccountMetadata): boolean {
  return Boolean(
    identity.externalAccountId ||
    (identity.accountEmail && identity.workspaceName),
  );
}

/** Profile identity for older Claude accounts is fetched outside any
 * transaction. */
async function prepareClaudeAccountIdentities(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PersonalProviderAccountMetadata> | null> {
  const rows = await db
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
  signal.throwIfAborted();
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

export const activatePersonalModelProviderAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<
    | ModelProviderResponse
    | ReturnType<typeof notFound>
    | ReturnType<typeof conflict>
  > => {
    const db = set(writeDb$);
    const result = await withAccountConflict(
      db.transaction(async (tx) => {
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
        const [account] = await tx
          .update(modelProviderAccounts)
          .set({ isActive: true, updatedAt: nowDate() })
          .where(eq(modelProviderAccounts.id, current.account.id))
          .returning();
        return account
          ? accountResponse({ account, provider: current.provider })
          : notFound("Resource not found");
      }),
    );
    signal.throwIfAborted();
    if (!("status" in result)) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

type PersonalAccountDisconnectSelection =
  | { readonly kind: "account"; readonly id: string }
  | {
      readonly kind: "provider";
      readonly type: PersonalSubscriptionProviderType;
    };

interface PersonalAccountDisconnection {
  readonly orgId: string;
  readonly userId: string;
  readonly selection: PersonalAccountDisconnectSelection;
  readonly featureSwitchContext: FeatureSwitchContext;
}

/** Profile/KMS preparation precedes the local disconnection transaction. */
export const disconnectPersonalModelProviderAccounts$ = command(
  async (
    { set },
    args: PersonalAccountDisconnection,
    signal: AbortSignal,
  ): Promise<
    ReturnType<typeof notFound> | ReturnType<typeof conflict> | undefined
  > => {
    const db = set(writeDb$);
    const accounts = await db
      .select()
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(modelProviderAccounts.userId, args.userId),
          isNull(modelProviderAccounts.disconnectedAt),
          args.selection.kind === "account"
            ? eq(modelProviderAccounts.id, args.selection.id)
            : eq(modelProviderAccounts.type, args.selection.type),
        ),
      )
      .orderBy(asc(modelProviderAccounts.id));
    signal.throwIfAborted();
    const first = accounts[0];
    if (!first || !isPersonalSubscriptionProviderType(first.type)) {
      return notFound("Resource not found");
    }
    const providerId = first.modelProviderId;
    const identities =
      first.type === CLAUDE_CODE_TYPE
        ? await prepareClaudeAccountIdentities(db, args, signal)
        : null;
    signal.throwIfAborted();
    const result = await withAccountConflict(
      db.transaction(async (tx) => {
        for (const account of await applyClaudeIdentities(
          tx,
          accounts,
          identities,
        )) {
          await tx.execute(retiringAccountStatement(account));
        }
        if (args.selection.kind === "account" && first.isActive) {
          const [replacement] = await tx
            .select({ id: modelProviderAccounts.id })
            .from(modelProviderAccounts)
            .where(connectedAccountCondition(providerId))
            .orderBy(
              asc(modelProviderAccounts.needsReconnect),
              asc(modelProviderAccounts.createdAt),
              asc(modelProviderAccounts.id),
            )
            .limit(1);
          if (replacement) {
            await tx
              .update(modelProviderAccounts)
              .set({ isActive: true, updatedAt: nowDate() })
              .where(eq(modelProviderAccounts.id, replacement.id));
          }
        }
        // Remove the logical provider once no account row, including a
        // retained one, still references it.
        await tx
          .delete(modelProviders)
          .where(
            and(
              eq(modelProviders.id, providerId),
              notExists(
                tx
                  .select({ id: modelProviderAccounts.id })
                  .from(modelProviderAccounts)
                  .where(eq(modelProviderAccounts.modelProviderId, providerId)),
              ),
            ),
          );
        return undefined;
      }),
    );
    signal.throwIfAborted();
    if (result === undefined) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

export async function personalModelProviderAccountById(args: {
  readonly db: ReadonlyDb;
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
        personalSubscriptionAccountAccessCondition(args.runId),
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
export function personalSubscriptionAccountAccessCondition(runId?: string) {
  const connected = isNull(modelProviderAccounts.disconnectedAt);
  return runId === undefined
    ? connected
    : or(
        connected,
        sql`EXISTS (
          SELECT 1 FROM ${agentRuns}
          WHERE ${agentRuns.id} = ${runId}
            AND ${agentRuns.orgId} = ${modelProviderAccounts.orgId}
            AND ${agentRuns.userId} = ${modelProviderAccounts.userId}
            AND ${agentRuns.modelProviderId} = ${modelProviderAccounts.id}
            AND ${agentRuns.status} IN ('pending', 'running')
        )`,
      );
}

/** The caller executes the statement in its terminal transaction. A retained
 * account is deleted once no live run references it, then its logical provider
 * once no account references it. */
export function disconnectedPersonalAccountCleanupSql(
  runs: readonly {
    readonly orgId: string;
    readonly userId: string;
    readonly modelProviderId: string | null;
  }[],
): readonly SQL[] {
  const accounts = new Map(
    runs.flatMap((run) => {
      return run.modelProviderId ? [[run.modelProviderId, run] as const] : [];
    }),
  );
  if (accounts.size === 0) {
    return [];
  }
  const affectedAccounts =
    or(
      ...[...accounts].map(([accountId, run]) => {
        return and(
          eq(modelProviderAccounts.id, accountId),
          eq(modelProviderAccounts.orgId, run.orgId),
          eq(modelProviderAccounts.userId, run.userId),
        );
      }),
    ) ?? sql`false`;
  return [
    sql`WITH deleted_accounts AS (
      DELETE FROM ${modelProviderAccounts}
      WHERE ${affectedAccounts}
        AND ${modelProviderAccounts.disconnectedAt} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${agentRuns}
          WHERE ${agentRuns.modelProviderId} = ${modelProviderAccounts.id}
            AND ${agentRuns.orgId} = ${modelProviderAccounts.orgId}
            AND ${agentRuns.userId} = ${modelProviderAccounts.userId}
            AND ${agentRuns.status} IN ('pending', 'running')
        )
      RETURNING ${modelProviderAccounts.id},
        ${modelProviderAccounts.modelProviderId}
    )
    DELETE FROM ${modelProviders}
    WHERE ${modelProviders.id} IN (
      SELECT model_provider_id FROM deleted_accounts
    ) AND NOT EXISTS (
      SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${modelProviderAccounts.modelProviderId} = ${modelProviders.id}
        AND NOT EXISTS (
          SELECT 1 FROM deleted_accounts
          WHERE deleted_accounts.id = ${modelProviderAccounts.id}
        )
    )`,
  ];
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
        personalSubscriptionAccountAccessCondition(args.runId),
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
