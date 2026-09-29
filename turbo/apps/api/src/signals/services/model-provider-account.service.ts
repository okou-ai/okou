import {
  deviceAuthSessionPublicationSql,
  type DeviceAuthSessionPublication,
} from "./model-provider-device-session-publication";
import { command } from "ccstate";
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
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { settle } from "../utils";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isUniqueViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
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

function isAccountMutationConflict(error: unknown): boolean {
  return isUniqueViolation(error) || safeSqlStateCode(error) === "40P01";
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

function matchingAccountIdentityCondition(
  type: PersonalSubscriptionProviderType,
  metadata: ReturnType<typeof accountMetadataValues>,
) {
  if (type === CODEX_TYPE) {
    return metadata.externalAccountId === null
      ? sql`false`
      : eq(modelProviderAccounts.externalAccountId, metadata.externalAccountId);
  }
  const emailAndWorkspace =
    metadata.accountEmail && metadata.workspaceName
      ? and(
          sql`lower(btrim(${modelProviderAccounts.accountEmail})) = ${metadata.accountEmail}`,
          sql`lower(btrim(${modelProviderAccounts.workspaceName})) = ${metadata.workspaceName.toLowerCase()}`,
        )
      : sql`false`;
  return metadata.externalAccountId
    ? or(
        eq(modelProviderAccounts.externalAccountId, metadata.externalAccountId),
        and(isNull(modelProviderAccounts.externalAccountId), emailAndWorkspace),
      )
    : emailAndWorkspace;
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

export type UpsertPersonalAccountArgs = {
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

interface PreparedPersonalAccountPublication {
  readonly authSession?: DeviceAuthSessionPublication;
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly authMethod: string | null;
  readonly mode: PersonalProviderAccountMutation;
  readonly selectedModel?: string;
  readonly metadata: ReturnType<typeof accountMetadataValues>;
  readonly encryptedSecrets: readonly EncryptedAccountSecret[];
  readonly identityProof: ReadonlyMap<
    string,
    ClaudeAccountIdentityProof
  > | null;
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

function retainedIdentityCondition(
  providerId: string,
  args: PreparedPersonalAccountPublication,
) {
  return and(
    eq(modelProviderAccounts.modelProviderId, providerId),
    isNotNull(modelProviderAccounts.disconnectedAt),
    matchingAccountIdentityCondition(args.type, args.metadata),
  );
}

function activeSiblingCondition(
  providerId: string,
  selected: AccountRow | null,
) {
  return and(
    eq(modelProviderAccounts.modelProviderId, providerId),
    eq(modelProviderAccounts.isActive, true),
    ...(selected ? [ne(modelProviderAccounts.id, selected.id)] : []),
  );
}

function accountPublicationInsertValues(
  args: PreparedPersonalAccountPublication,
  providerId: string,
  values: Exclude<
    ReturnType<typeof planAccountMutation>,
    { readonly status: number }
  >["values"],
) {
  return {
    ...values,
    modelProviderId: providerId,
    orgId: args.orgId,
    userId: args.userId,
    type: args.type,
  };
}

function logicalProviderInsertValues(args: PreparedPersonalAccountPublication) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    type: args.type,
    isDefault: false,
    selectedModel: args.selectedModel ?? null,
  };
}

function logicalProviderConflict() {
  return {
    target: [modelProviders.orgId, modelProviders.userId, modelProviders.type],
    set: { id: sql`${modelProviders.id}` },
  };
}

function accountIdentityConflict(
  values: Exclude<
    ReturnType<typeof planAccountMutation>,
    { readonly status: number }
  >["values"],
) {
  return {
    target: [
      modelProviderAccounts.modelProviderId,
      modelProviderAccounts.externalAccountId,
    ],
    set: {
      ...values,
      isActive: sql`${modelProviderAccounts.isActive} OR excluded.is_active`,
    },
  };
}

const publishPersonalModelProviderAccount$ = command(
  async (
    { set },
    args: PreparedPersonalAccountPublication,
    signal: AbortSignal,
  ): Promise<UpsertPersonalAccountResult> => {
    const db = set(writeDb$);
    const expiryBindings = new Set<string | null>();
    const outcome = await settle(
      db.transaction(async (tx) => {
        // The existing logical parent serializes its finite account-set mutation.
        const [provider] = await tx
          .insert(modelProviders)
          .values(logicalProviderInsertValues(args))
          .onConflictDoUpdate(logicalProviderConflict())
          .returning();
        if (!provider) {
          throw new Error("Expected logical model provider row");
        }
        const connected = await tx
          .select()
          .from(modelProviderAccounts)
          .where(connectedAccountCondition(provider.id))
          .orderBy(modelProviderAccounts.id)
          .limit(MAX_PERSONAL_PROVIDER_ACCOUNTS + 1);
        if (connected.length > MAX_PERSONAL_PROVIDER_ACCOUNTS) {
          return conflict(ACCOUNT_CONFLICT_MESSAGE);
        }
        const accounts: AccountRow[] = [];
        for (const account of connected) {
          const proof = args.identityProof?.get(account.id);
          if (proof && !hasClaudeIdentity(account)) {
            const [updated] = await tx
              .update(modelProviderAccounts)
              .set(claudeIdentityValues(proof.metadata))
              .where(claudeIdentityProofCondition(account.id, proof))
              .returning();
            accounts.push(updated ?? account);
          } else {
            accounts.push(account);
          }
        }
        const [retained] = await tx
          .select()
          .from(modelProviderAccounts)
          .where(retainedIdentityCondition(provider.id, args))
          .orderBy(modelProviderAccounts.id)
          .limit(1);
        if (retained) {
          accounts.push(retained);
        }
        accounts.sort((left, right) => {
          return left.id.localeCompare(right.id);
        });
        const plan = planAccountMutation({ ...args, accounts });
        if ("status" in plan) {
          return plan;
        }
        for (const binding of affectedCodexExpiryBindings({
          ...args,
          accounts,
        })) {
          expiryBindings.add(binding);
        }
        invalidateAccountExpiry(args, expiryBindings);
        if (plan.retiring) {
          await tx.execute(retiringAccountStatement(plan.retiring));
        }
        if (plan.values.isActive) {
          await tx
            .update(modelProviderAccounts)
            .set({ isActive: false })
            .where(activeSiblingCondition(provider.id, plan.selected));
        }
        const [account] = plan.selected
          ? await tx
              .update(modelProviderAccounts)
              .set(plan.values)
              .where(eq(modelProviderAccounts.id, plan.selected.id))
              .returning()
          : await tx
              .insert(modelProviderAccounts)
              .values(
                accountPublicationInsertValues(args, provider.id, plan.values),
              )
              .onConflictDoUpdate(accountIdentityConflict(plan.values))
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
        signal.throwIfAborted();
        return {
          provider: accountResponse({
            account,
            provider: { ...provider, selectedModel },
          }),
          created: !plan.selected,
        };
      }),
    ).finally(() => {
      invalidateAccountExpiry(args, expiryBindings);
    });
    signal.throwIfAborted();
    if (!outcome.ok) {
      if (isAccountMutationConflict(outcome.error)) {
        return conflict(ACCOUNT_CONFLICT_MESSAGE);
      }
      throw outcome.error;
    }
    return outcome.value;
  },
);

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
    const identityProof =
      args.type === CLAUDE_CODE_TYPE
        ? await set(prepareClaudeAccountIdentities$, args, signal)
        : null;
    signal.throwIfAborted();
    const result = await set(
      publishPersonalModelProviderAccount$,
      {
        ...args,
        encryptedSecrets,
        identityProof,
        metadata: accountMetadataValues({
          type: args.type,
          metadata,
          secretValues: args.secretValues,
        }),
      },
      signal,
    );
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
 * transaction and recorded only while the row still lacks an identity. */
interface ClaudeAccountIdentityProof {
  readonly metadata: PersonalProviderAccountMetadata;
  readonly encryptedValue: string;
  readonly stateRevision: string;
}

function claudeIdentityProofCondition(
  accountId: string,
  proof: ClaudeAccountIdentityProof,
) {
  return and(
    eq(modelProviderAccounts.id, accountId),
    isNull(modelProviderAccounts.externalAccountId),
    or(
      isNull(modelProviderAccounts.accountEmail),
      isNull(modelProviderAccounts.workspaceName),
    ),
    sql`${modelProviderAccounts.updatedAt}::text = ${proof.stateRevision}`,
    sql`EXISTS (
      SELECT 1 FROM ${modelProviderAccountSecrets}
      WHERE ${modelProviderAccountSecrets.modelProviderAccountId} = ${modelProviderAccounts.id}
        AND ${modelProviderAccountSecrets.name} = 'CLAUDE_CODE_OAUTH_TOKEN'
        AND ${modelProviderAccountSecrets.encryptedValue} = ${proof.encryptedValue}
    )`,
  );
}

function claudeIdentityValues(metadata: PersonalProviderAccountMetadata) {
  return {
    externalAccountId: metadata.externalAccountId ?? null,
    accountEmail: metadata.accountEmail ?? null,
    workspaceName: metadata.workspaceName ?? null,
  };
}

const prepareClaudeAccountIdentities$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ClaudeAccountIdentityProof> | null> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        account: modelProviderAccounts,
        encryptedValue: modelProviderAccountSecrets.encryptedValue,
        stateRevision: sql`${modelProviderAccounts.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
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
      )
      .limit(MAX_PERSONAL_PROVIDER_ACCOUNTS + 1);
    signal.throwIfAborted();
    return await fetchClaudeAccountIdentityProofs(
      rows,
      args.featureSwitchContext,
      signal,
    );
  },
);

async function fetchClaudeAccountIdentityProofs(
  rows: readonly {
    readonly account: AccountRow;
    readonly encryptedValue: string;
    readonly stateRevision: string;
  }[],
  featureSwitchContext: FeatureSwitchContext,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ClaudeAccountIdentityProof> | null> {
  const identities = new Map<string, ClaudeAccountIdentityProof>();
  for (const row of rows) {
    if (hasClaudeIdentity(row.account)) {
      continue;
    }
    const accessToken = await decryptStoredSecretValue(
      row.encryptedValue,
      featureSwitchContext,
    );
    signal.throwIfAborted();
    const result = await settle(
      fetchClaudeCodeProfileMetadata({ accessToken }, signal),
    );
    signal.throwIfAborted();
    if (result.ok && hasClaudeIdentity(result.value)) {
      identities.set(row.account.id, {
        metadata: result.value,
        encryptedValue: row.encryptedValue,
        stateRevision: row.stateRevision,
      });
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
    const mutation = await settle(
      db.transaction(async (tx) => {
        const [current] = await tx
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
        // The existing one-active unique index arbitrates concurrent activation.
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
        signal.throwIfAborted();
        return account
          ? accountResponse({ account, provider: current.provider })
          : notFound("Resource not found");
      }),
    );
    signal.throwIfAborted();
    if (!mutation.ok) {
      if (isAccountMutationConflict(mutation.error)) {
        return conflict(ACCOUNT_CONFLICT_MESSAGE);
      }
      throw mutation.error;
    }
    const result = mutation.value;
    if (!("status" in result)) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

function unreferencedProviderCondition(providerId: string) {
  return and(
    eq(modelProviders.id, providerId),
    sql`NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${modelProviderAccounts.modelProviderId} = ${providerId}
  )`,
  );
}

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

function selectedAccountDisconnectCondition(
  selection: PersonalAccountDisconnectSelection,
) {
  return selection.kind === "account"
    ? eq(modelProviderAccounts.id, selection.id)
    : eq(modelProviderAccounts.type, selection.type);
}

const publishPersonalAccountDisconnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly providerId: string;
      readonly selection: PersonalAccountDisconnectSelection;
      readonly identityProof: ReadonlyMap<
        string,
        ClaudeAccountIdentityProof
      > | null;
    },
    signal: AbortSignal,
  ): Promise<
    ReturnType<typeof notFound> | ReturnType<typeof conflict> | undefined
  > => {
    const db = set(writeDb$);
    const mutation = await settle(
      db.transaction(async (tx) => {
        // Account publication takes the same existing parent row first. This
        // bounds all-account deletion without racing a new connected sibling.
        const [provider] = await tx
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(
            and(
              eq(modelProviders.id, args.providerId),
              eq(modelProviders.orgId, args.orgId),
              eq(modelProviders.userId, args.userId),
            ),
          )
          .for("update")
          .limit(1);
        if (!provider) {
          return notFound("Resource not found");
        }
        const accounts = await tx
          .select()
          .from(modelProviderAccounts)
          .where(
            and(
              connectedAccountCondition(provider.id),
              selectedAccountDisconnectCondition(args.selection),
            ),
          )
          .orderBy(asc(modelProviderAccounts.id))
          .for("update")
          .limit(MAX_PERSONAL_PROVIDER_ACCOUNTS + 1);
        if (accounts.length === 0) {
          return notFound("Resource not found");
        }
        if (accounts.length > MAX_PERSONAL_PROVIDER_ACCOUNTS) {
          return conflict(ACCOUNT_CONFLICT_MESSAGE);
        }
        for (const account of accounts) {
          const identity = args.identityProof?.get(account.id);
          if (identity && !hasClaudeIdentity(account)) {
            await tx
              .update(modelProviderAccounts)
              .set(claudeIdentityValues(identity.metadata))
              .where(claudeIdentityProofCondition(account.id, identity));
          }
          await tx.execute(retiringAccountStatement(account));
        }
        if (args.selection.kind === "account" && accounts[0]?.isActive) {
          const [replacement] = await tx
            .select({ id: modelProviderAccounts.id })
            .from(modelProviderAccounts)
            .where(connectedAccountCondition(provider.id))
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
              .where(
                and(
                  eq(modelProviderAccounts.id, replacement.id),
                  isNull(modelProviderAccounts.disconnectedAt),
                ),
              );
          }
        }
        await tx
          .delete(modelProviders)
          .where(unreferencedProviderCondition(provider.id));
        signal.throwIfAborted();
        return undefined;
      }),
    );
    signal.throwIfAborted();
    if (!mutation.ok) {
      if (isAccountMutationConflict(mutation.error)) {
        return conflict(ACCOUNT_CONFLICT_MESSAGE);
      }
      throw mutation.error;
    }
    if (mutation.value === undefined) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return mutation.value;
  },
);

/** Profile/KMS preparation precedes the finite local disconnection transaction. */
export const disconnectPersonalModelProviderAccounts$ = command(
  async (
    { set },
    args: PersonalAccountDisconnection,
    signal: AbortSignal,
  ): Promise<
    ReturnType<typeof notFound> | ReturnType<typeof conflict> | undefined
  > => {
    const db = set(writeDb$);
    const [initial] = await db
      .select({
        providerId: modelProviderAccounts.modelProviderId,
        type: modelProviderAccounts.type,
      })
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(modelProviderAccounts.userId, args.userId),
          isNull(modelProviderAccounts.disconnectedAt),
          selectedAccountDisconnectCondition(args.selection),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!initial || !isPersonalSubscriptionProviderType(initial.type)) {
      return notFound("Resource not found");
    }
    const identityProof =
      initial.type === CLAUDE_CODE_TYPE
        ? await set(
            prepareClaudeAccountIdentities$,
            {
              orgId: args.orgId,
              userId: args.userId,
              featureSwitchContext: args.featureSwitchContext,
            },
            signal,
          )
        : null;
    signal.throwIfAborted();
    return await set(
      publishPersonalAccountDisconnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        providerId: initial.providerId,
        selection: args.selection,
        identityProof,
      },
      signal,
    );
  },
);

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

export function visiblePersonalModelProviderCondition() {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${modelProviderAccounts.modelProviderId} = ${modelProviders.id}
    ) OR EXISTS (
      SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${modelProviderAccounts.modelProviderId} = ${modelProviders.id}
        AND ${modelProviderAccounts.disconnectedAt} IS NULL
    )
  )`;
}

/** The caller executes both statements in its terminal transaction. The first
 * locks only the affected existing parents, in the same order as account
 * publication. The second gets a fresh statement snapshot after any publisher
 * finishes, so deleting an empty parent cannot cascade a new sibling account.
 * The builder receives only the actual terminal transition's business values. */
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
    sql`SELECT ${modelProviders.id} FROM ${modelProviders}
      WHERE ${modelProviders.id} IN (
        SELECT ${modelProviderAccounts.modelProviderId}
        FROM ${modelProviderAccounts} WHERE ${affectedAccounts}
      )
      ORDER BY ${modelProviders.id} FOR UPDATE`,
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
