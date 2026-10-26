import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  notExists,
} from "drizzle-orm";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isUniqueViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { alias, QueryBuilder, type AnyPgColumn } from "drizzle-orm/pg-core";
import { db$, writeDb$ } from "../external/db";
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
import {
  logicalProviderIdentityCondition,
  logicalProviderIdentityValues,
  claudeAccountIdentityToApply,
  claudeAccountIdentityValues,
  hasClaudeIdentity,
  type PersonalProviderAccountMetadata,
} from "./model-provider-account-identity";

const MAX_PERSONAL_PROVIDER_ACCOUNTS = 10;
const CODEX_TYPE = "codex-oauth-token";
const CLAUDE_CODE_TYPE = "claude-code-oauth-token";
const CODEX_ACCOUNT_ID_SECRET = "CHATGPT_ACCOUNT_ID";
const ACCOUNT_CONFLICT_MESSAGE =
  "The subscription account changed concurrently. Refresh and try again.";

export type PersonalSubscriptionProviderType =
  typeof CODEX_TYPE | typeof CLAUDE_CODE_TYPE;

/** Connected Claude/Codex member accounts read together for one queued model route. */
export interface MemberModelAccountSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly accounts: readonly (typeof modelProviderAccounts.$inferSelect)[];
}

export function isPersonalSubscriptionProviderType(
  type: string,
): type is PersonalSubscriptionProviderType {
  return type === CODEX_TYPE || type === CLAUDE_CODE_TYPE;
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
/** Explicit projection: never read every `model_providers` column, so a
 * rolling deploy survives column drops on the logical provider row. */
const providerColumns = { id: modelProviders.id } as const;
type ProviderRow = { readonly id: string };
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
  return {
    id: account.id,
    modelProviderId: provider.id,
    isActive: account.isActive,
    type,
    framework: getFrameworkForType(type),
    accountEmail: account.accountEmail,
    workspaceName: account.workspaceName,
    planType: account.planType,
    subscriptionResetSupported: type === CODEX_TYPE,
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

export function personalModelProviderAccounts(
  scope$: Computed<{
    readonly orgId: string;
    readonly userId: string;
  }>,
) {
  return computed(async (get): Promise<ModelProviderListResponse> => {
    const scope = get(scope$);
    const db = get(db$);
    const rows = await db
      .select({ account: modelProviderAccounts, provider: providerColumns })
      .from(modelProviderAccounts)
      .innerJoin(
        modelProviders,
        eq(modelProviderAccounts.modelProviderId, modelProviders.id),
      )
      .where(
        and(
          eq(modelProviderAccounts.orgId, scope.orgId),
          eq(modelProviderAccounts.userId, scope.userId),
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
  });
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
      { orgId: args.orgId, userId: args.userId },
      { binding },
    );
  }
}

interface PreparedPersonalAccountPublication {
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly providerId: string | null;
  readonly plan: ReturnType<typeof planAccountMutation>;
  readonly identities: readonly {
    readonly id: string;
    readonly values: ReturnType<typeof claudeAccountIdentityValues>;
  }[];
  readonly encryptedSecrets: readonly EncryptedAccountSecret[];
  readonly authSession?: DeviceAuthSessionPublication;
}

function preparedPersonalAccountPublication(
  args: Omit<UpsertPersonalAccountArgs, "metadata"> & {
    readonly metadata: ReturnType<typeof accountMetadataValues>;
    readonly encryptedSecrets: readonly EncryptedAccountSecret[];
    readonly identities: ReadonlyMap<
      string,
      PersonalProviderAccountMetadata
    > | null;
  },
  provider: ProviderRow | undefined,
  accounts: readonly AccountRow[],
) {
  const identities: PreparedPersonalAccountPublication["identities"][number][] =
    [];
  const hydrated = accounts.map((account) => {
    const metadata = claudeAccountIdentityToApply(account, args.identities);
    if (!metadata) {
      return account;
    }
    const values = claudeAccountIdentityValues(metadata);
    identities.push({ id: account.id, values });
    return { ...account, ...values };
  });
  return {
    publication: {
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      providerId: provider?.id ?? null,
      plan: planAccountMutation({ ...args, accounts: hydrated }),
      identities,
      encryptedSecrets: args.encryptedSecrets,
      ...(args.authSession ? { authSession: args.authSession } : {}),
    } satisfies PreparedPersonalAccountPublication,
    expiryBindings: affectedCodexExpiryBindings({
      ...args,
      accounts: hydrated,
    }),
  };
}

function personalAccountIdentityPublicationValue(
  identities: PreparedPersonalAccountPublication["identities"],
  key: keyof ReturnType<typeof claudeAccountIdentityValues>,
  column: AnyPgColumn,
) {
  if (identities.length === 0) {
    return sql`${column}`;
  }
  const branches = identities.map((identity) => {
    return sql`WHEN ${identity.id}::uuid THEN ${sql.param(identity.values[key], column)}`;
  });
  return sql`CASE ${modelProviderAccounts.id}
    ${sql.join(branches, sql` `)} ELSE ${column} END`;
}

function retainedPersonalAccountPublicationCondition(
  account: AccountRow | null,
) {
  if (account === null) {
    return sql`false`;
  }
  return and(
    eq(modelProviderAccounts.id, account.id),
    isNull(modelProviderAccounts.disconnectedAt),
    exists(
      new QueryBuilder()
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.modelProviderId, account.id),
            eq(agentRuns.orgId, account.orgId),
            eq(agentRuns.userId, account.userId),
            inArray(agentRuns.status, ["pending", "running"]),
          ),
        ),
    ),
  );
}

function personalAccountPublicationError(error: unknown) {
  if (safeSqlStateCode(error) !== "22P02" || !(error instanceof Error)) {
    return error;
  }
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("message" in cause)) {
    return error;
  }
  if (
    cause.message ===
    'invalid input syntax for type integer: "personal-account-publication:account:0"'
  ) {
    return new Error("Expected subscription account mutation to return");
  }
  if (
    cause.message ===
    'invalid input syntax for type integer: "personal-account-publication:consent:0"'
  ) {
    return new Error("Device authorization was cancelled or expired");
  }
  return error;
}

const personalAccountPublicationColumns = alias(
  modelProviderAccounts,
  "personal_publication_account",
);

function personalAccountOtherPublicationPlan(
  args: PreparedPersonalAccountPublication,
  providerId: SQL,
  retiredAt: Date,
) {
  const mutation = "status" in args.plan ? null : args.plan;
  const retained = retainedPersonalAccountPublicationCondition(
    mutation?.retiring ?? null,
  );
  const clearedActive = mutation?.values.isActive
    ? eq(modelProviderAccounts.isActive, true)
    : sql`false`;
  const backfilled =
    args.identities.length > 0
      ? inArray(
          modelProviderAccounts.id,
          args.identities.map((identity) => {
            return identity.id;
          }),
        )
      : sql`false`;
  return {
    values: {
      externalAccountId: personalAccountIdentityPublicationValue(
        args.identities,
        "externalAccountId",
        modelProviderAccounts.externalAccountId,
      ),
      accountEmail: personalAccountIdentityPublicationValue(
        args.identities,
        "accountEmail",
        modelProviderAccounts.accountEmail,
      ),
      workspaceName: personalAccountIdentityPublicationValue(
        args.identities,
        "workspaceName",
        modelProviderAccounts.workspaceName,
      ),
      isActive: sql`CASE WHEN (${retained}) OR (${clearedActive}) THEN false ELSE ${modelProviderAccounts.isActive} END`,
      disconnectedAt: sql`CASE WHEN ${retained} THEN ${sql.param(retiredAt, modelProviderAccounts.disconnectedAt)} ELSE ${modelProviderAccounts.disconnectedAt} END`,
      updatedAt: sql`CASE WHEN ${retained} THEN ${sql.param(retiredAt, modelProviderAccounts.updatedAt)} ELSE ${modelProviderAccounts.updatedAt} END`,
    },
    condition: and(
      eq(modelProviderAccounts.modelProviderId, providerId),
      mutation?.selected
        ? ne(modelProviderAccounts.id, mutation.selected.id)
        : undefined,
      or(retained, clearedActive, backfilled),
      mutation?.retiring
        ? or(ne(modelProviderAccounts.id, mutation.retiring.id), retained)
        : undefined,
    ),
  };
}

function personalAccountSecretPublicationPlan(
  args: PreparedPersonalAccountPublication,
  accountId: string,
  written: SQL,
) {
  const names = args.encryptedSecrets.map((secret) => {
    return secret.name;
  });
  const rows = args.encryptedSecrets.map((secret) => {
    return sql`(${secret.name}, ${secret.encryptedValue}, ${secret.description})`;
  });
  return {
    deleteWhere: and(
      eq(modelProviderAccountSecrets.modelProviderAccountId, accountId),
      names.length > 0
        ? notInArray(modelProviderAccountSecrets.name, names)
        : undefined,
      written,
    ),
    rows:
      rows.length === 0
        ? null
        : sql`SELECT
      gen_random_uuid(), ${accountId}::uuid, published.name, published.encrypted_value,
      published.description, now(), now()
      FROM (VALUES ${sql.join(rows, sql`, `)}) AS published(name, encrypted_value, description)
      WHERE ${written}`,
    conflict: {
      target: [
        modelProviderAccountSecrets.modelProviderAccountId,
        modelProviderAccountSecrets.name,
      ],
      set: {
        encryptedValue: sql`excluded.encrypted_value`,
        description: sql`excluded.description`,
        updatedAt: nowDate(),
      },
    },
  };
}

function personalAccountPublicationChecks(
  hasSecrets: boolean,
  hasConsent: boolean,
) {
  const builder = new QueryBuilder();
  const accounts = sql`(${builder.select({ value: count() }).from(sql`personal_publication_account`)})`;
  const removedSecrets = sql`(${builder.select({ value: count() }).from(sql`personal_publication_removed_secrets`)})`;
  const secrets = hasSecrets
    ? sql`(${builder.select({ value: count() }).from(sql`personal_publication_secrets`)})`
    : sql`0`;
  const consent = hasConsent
    ? sql`(${builder.select({ value: count() }).from(sql`personal_publication_consent`)})`
    : sql`1`;
  return {
    readyAt: sql`(SELECT clock_timestamp() FROM
      (SELECT ${accounts} + ${removedSecrets} + ${secrets} AS writes) AS publication_ready
      WHERE publication_ready.writes >= 0)`,
    checked: sql`CASE
      WHEN ${accounts} <> 1 THEN ('personal-account-publication:account:' || ${accounts})::integer
      WHEN ${consent} <> 1 THEN ('personal-account-publication:consent:' || ${consent})::integer
      ELSE 1 END = 1`,
  };
}

type PlannedPersonalAccountMutation = Extract<
  ReturnType<typeof planAccountMutation>,
  { readonly selected: AccountRow | null }
>;

function personalAccountMutationPublicationPlan(
  args: PreparedPersonalAccountPublication,
  mutation: PlannedPersonalAccountMutation,
  providerId: SQL,
) {
  const id = mutation.selected?.id ?? crypto.randomUUID();
  const values = {
    ...mutation.values,
    atomGrantId:
      args.authSession?.source === "atom-subscription-grant"
        ? args.authSession.id
        : null,
  };
  return {
    id,
    values,
    existing: mutation.selected !== null,
    insert: {
      ...values,
      id,
      modelProviderId: providerId,
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
    },
    where: and(
      eq(modelProviderAccounts.id, id),
      eq(modelProviderAccounts.modelProviderId, providerId),
    ),
  };
}

function personalAccountRetirementPublicationCondition(
  account: AccountRow | null,
) {
  return and(
    account ? eq(modelProviderAccounts.id, account.id) : sql`false`,
    isNull(modelProviderAccounts.disconnectedAt),
    notExists(
      new QueryBuilder()
        .select({
          id: sql`personal_publication_other_accounts.id`.mapWith(
            modelProviderAccounts.id,
          ),
        })
        .from(sql`personal_publication_other_accounts`)
        .where(
          eq(
            sql`personal_publication_other_accounts.id`,
            modelProviderAccounts.id,
          ),
        ),
    ),
  );
}

function personalAccountPublicationResult(
  result:
    | {
        readonly ok: true;
        readonly value: readonly { readonly account: AccountRow | null }[];
      }
    | { readonly ok: false; readonly error: unknown },
  created: boolean,
): UpsertPersonalAccountResult {
  if (!result.ok) {
    throw personalAccountPublicationError(result.error);
  }
  const account = result.value[0]?.account;
  if (!account) {
    throw new Error("Expected subscription account mutation to return");
  }
  return {
    provider: accountResponse({
      account,
      provider: { id: account.modelProviderId },
    }),
    created,
  };
}

function personalProviderPublicationPlan(
  args: PreparedPersonalAccountPublication,
) {
  return {
    values: logicalProviderIdentityValues(args),
    where: and(
      logicalProviderIdentityCondition(args),
      args.providerId === null
        ? sql`false`
        : eq(modelProviders.id, args.providerId),
    ),
  };
}

function personalAccountConsentPlan(
  args: PreparedPersonalAccountPublication,
  accountId: string,
) {
  const checks = personalAccountPublicationChecks(
    args.encryptedSecrets.length > 0,
    args.authSession !== undefined,
  );
  return {
    checked: checks.checked,
    sql: deviceAuthSessionPublicationSql({
      ...args,
      modelProviderAccountId: accountId,
      publicationReadyAt: checks.readyAt,
    }),
  };
}

const commitPersonalAccountPublication$ = command(
  async (
    { set },
    args: PreparedPersonalAccountPublication,
  ): Promise<UpsertPersonalAccountResult> => {
    const db = set(writeDb$);
    const providerPlan = personalProviderPublicationPlan(args);
    const provider = db
      .$with("personal_publication_provider")
      .as(
        args.providerId === null
          ? db
              .insert(modelProviders)
              .values(providerPlan.values)
              .returning(providerColumns)
          : db
              .select(providerColumns)
              .from(modelProviders)
              .where(providerPlan.where),
      );
    const otherPlan = personalAccountOtherPublicationPlan(
      args,
      sql`(${db.select({ id: provider.id }).from(provider)})`,
      nowDate(),
    );
    const others = db
      .$with("personal_publication_other_accounts")
      .as(
        db
          .update(modelProviderAccounts)
          .set(otherPlan.values)
          .where(otherPlan.condition)
          .returning({ id: modelProviderAccounts.id }),
      );
    if ("status" in args.plan) {
      await db.with(provider, others).select().from(provider);
      return args.plan;
    }
    const mutation = args.plan;
    const deleted = db
      .$with("personal_publication_retired_account")
      .as(
        db
          .delete(modelProviderAccounts)
          .where(
            personalAccountRetirementPublicationCondition(mutation.retiring),
          )
          .returning({ id: modelProviderAccounts.id }),
      );
    const providerId = sql`(${db
      .select({ id: provider.id })
      .from(provider)
      .where(
        sql`(${db.select({ value: count() }).from(others)}) + (${db.select({ value: count() }).from(deleted)}) >= 0`,
      )})`;
    const accountPlan = personalAccountMutationPublicationPlan(
      args,
      mutation,
      providerId,
    );
    const accountId = accountPlan.id;
    const written = db
      .$with("personal_publication_account")
      .as(
        accountPlan.existing
          ? db
              .update(modelProviderAccounts)
              .set(accountPlan.values)
              .where(accountPlan.where)
              .returning()
          : db
              .insert(modelProviderAccounts)
              .values(accountPlan.insert)
              .returning(),
      );
    const secretPlan = personalAccountSecretPublicationPlan(
      args,
      accountId,
      exists(db.select({ id: written.id }).from(written)),
    );
    const removedSecrets = db
      .$with("personal_publication_removed_secrets")
      .as(
        db
          .delete(modelProviderAccountSecrets)
          .where(secretPlan.deleteWhere)
          .returning({ id: modelProviderAccountSecrets.id }),
      );
    const secrets =
      secretPlan.rows === null
        ? undefined
        : db
            .$with("personal_publication_secrets")
            .as(
              db
                .insert(modelProviderAccountSecrets)
                .select(secretPlan.rows)
                .onConflictDoUpdate(secretPlan.conflict)
                .returning({ id: modelProviderAccountSecrets.id }),
            );
    const consentPlan = personalAccountConsentPlan(args, accountId);
    const consentSql = consentPlan.sql;
    const consent =
      consentSql === undefined
        ? undefined
        : db
            .$with("personal_publication_consent", {
              id: modelProviderAuthSessions.id,
            })
            .as(consentSql);
    const result = await settle(
      db
        .with(
          provider,
          others,
          deleted,
          written,
          removedSecrets,
          ...(secrets ? [secrets] : []),
          ...(consent ? [consent] : []),
        )
        .select({ account: personalAccountPublicationColumns })
        .from(sql`(SELECT 1) AS personal_publication_result`)
        .leftJoin(written, sql`true`)
        .where(consentPlan.checked),
    );
    return personalAccountPublicationResult(result, !mutation.selected);
  },
);

export const upsertPersonalModelProviderAccount$ = command(
  async (
    { get, set },
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
    const db = get(db$);
    const identities =
      args.type === CLAUDE_CODE_TYPE
        ? await set(prepareClaudeAccountIdentities$, args, signal)
        : null;
    signal.throwIfAborted();
    const [provider] = await db
      .select(providerColumns)
      .from(modelProviders)
      .where(logicalProviderIdentityCondition(args))
      .limit(1);
    signal.throwIfAborted();
    const accounts = provider
      ? await db
          .select()
          .from(modelProviderAccounts)
          .where(eq(modelProviderAccounts.modelProviderId, provider.id))
          .orderBy(modelProviderAccounts.id)
      : [];
    signal.throwIfAborted();
    const prepared = preparedPersonalAccountPublication(
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
      provider,
      accounts,
    );
    const expiryBindings = new Set<string | null>(
      "status" in prepared.publication.plan ? [] : prepared.expiryBindings,
    );
    const result = await withAccountConflict(
      set(commitPersonalAccountPublication$, prepared.publication),
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

/** Profile identity for older Claude accounts is fetched outside any
 * transaction. */
const prepareClaudeAccountIdentities$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, PersonalProviderAccountMetadata> | null> => {
    const rows = await get(db$)
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
  },
);

function exactConnectedPersonalAccountCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly id: string;
}) {
  return and(
    eq(modelProviderAccounts.id, args.id),
    isNull(modelProviderAccounts.disconnectedAt),
    eq(modelProviderAccounts.orgId, args.orgId),
    eq(modelProviderAccounts.userId, args.userId),
  );
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
    const target = db.$with("activation_target").as(
      db
        .select({
          id: modelProviderAccounts.id,
          modelProviderId: modelProviderAccounts.modelProviderId,
        })
        .from(modelProviderAccounts)
        .innerJoin(
          modelProviders,
          eq(modelProviderAccounts.modelProviderId, modelProviders.id),
        )
        .where(
          and(
            exactConnectedPersonalAccountCondition(args),
            inArray(modelProviderAccounts.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
          ),
        ),
    );
    const siblings = and(
      inArray(
        modelProviderAccounts.modelProviderId,
        db.select({ id: target.modelProviderId }).from(target),
      ),
      eq(modelProviderAccounts.isActive, true),
      ne(modelProviderAccounts.id, args.id),
    );
    const changedAt = nowDate();
    const deactivated = db
      .$with("deactivated_accounts")
      .as(
        db
          .update(modelProviderAccounts)
          .set({ isActive: false, updatedAt: changedAt })
          .where(siblings)
          .returning({ id: modelProviderAccounts.id }),
      );
    const activated = db.$with("activated_account").as(
      db
        .update(modelProviderAccounts)
        .set({ isActive: true, updatedAt: changedAt })
        .where(
          and(
            exactConnectedPersonalAccountCondition(args),
            inArray(modelProviderAccounts.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
            inArray(
              modelProviderAccounts.modelProviderId,
              db.select({ id: target.modelProviderId }).from(target),
            ),
            // Consume the actual RETURNING before inserting the active index
            // entry. At most one distinct sibling can be active. If a concurrent
            // writer changed it, reject instead of adopting a stale switch.
            eq(
              db.select({ count: count() }).from(deactivated),
              db
                .select({ count: count() })
                .from(modelProviderAccounts)
                .where(siblings),
            ),
          ),
        )
        .returning(),
    );
    const rows = await withAccountConflict(
      db
        .with(target, deactivated, activated)
        .select()
        .from(target)
        .leftJoin(activated, eq(activated.id, target.id)),
    );
    signal.throwIfAborted();
    if ("status" in rows) {
      return rows;
    }
    const row = rows[0];
    if (!row) {
      return notFound("Resource not found");
    }
    const account = row.activated_account;
    if (!account) {
      return conflict(ACCOUNT_CONFLICT_MESSAGE);
    }
    const result = accountResponse({
      account,
      provider: { id: row.activation_target.modelProviderId },
    });
    await publishPersonalModelProvidersChangedSafely(args.userId);
    signal.throwIfAborted();
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

function disconnectionIdentityValues(
  accounts: readonly AccountRow[],
  identities: ReadonlyMap<string, PersonalProviderAccountMetadata> | null,
) {
  const hydrated = accounts.flatMap((account) => {
    const metadata = claudeAccountIdentityToApply(account, identities);
    return metadata
      ? [{ id: account.id, values: claudeAccountIdentityValues(metadata) }]
      : [];
  });
  if (hydrated.length === 0) {
    return {};
  }
  return {
    externalAccountId: sql`CASE ${sql.join(
      hydrated.map(({ id, values }) => {
        return sql`WHEN ${eq(modelProviderAccounts.id, id)} THEN ${values.externalAccountId}`;
      }),
      sql` `,
    )} ELSE ${modelProviderAccounts.externalAccountId} END`,
    accountEmail: sql`CASE ${sql.join(
      hydrated.map(({ id, values }) => {
        return sql`WHEN ${eq(modelProviderAccounts.id, id)} THEN ${values.accountEmail}`;
      }),
      sql` `,
    )} ELSE ${modelProviderAccounts.accountEmail} END`,
    workspaceName: sql`CASE ${sql.join(
      hydrated.map(({ id, values }) => {
        return sql`WHEN ${eq(modelProviderAccounts.id, id)} THEN ${values.workspaceName}`;
      }),
      sql` `,
    )} ELSE ${modelProviderAccounts.workspaceName} END`,
  };
}

interface PreparedPersonalAccountDisconnection {
  readonly orgId: string;
  readonly userId: string;
  readonly providerId: string;
  readonly accounts: readonly AccountRow[];
  readonly identities: ReadonlyMap<
    string,
    PersonalProviderAccountMetadata
  > | null;
  readonly promoteReplacement: boolean;
}

const commitPersonalAccountDisconnection$ = command(
  async (
    { set },
    input: PreparedPersonalAccountDisconnection,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { accounts, identities, providerId } = input;
    const ids = accounts.map((account) => {
      return account.id;
    });
    const disconnectedAt = nowDate();
    const retained = db.$with("retained_accounts").as(
      db
        .update(modelProviderAccounts)
        .set({
          ...disconnectionIdentityValues(accounts, identities),
          isActive: false,
          disconnectedAt,
          updatedAt: disconnectedAt,
        })
        .where(
          and(
            inArray(modelProviderAccounts.id, ids),
            isNull(modelProviderAccounts.disconnectedAt),
            exists(
              db
                .select({ id: agentRuns.id })
                .from(agentRuns)
                .where(
                  and(
                    eq(agentRuns.modelProviderId, modelProviderAccounts.id),
                    eq(agentRuns.orgId, input.orgId),
                    eq(agentRuns.userId, input.userId),
                    inArray(agentRuns.status, ["pending", "running"]),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: modelProviderAccounts.id }),
    );
    const deleted = db.$with("deleted_accounts").as(
      db
        .delete(modelProviderAccounts)
        .where(
          and(
            inArray(modelProviderAccounts.id, ids),
            isNull(modelProviderAccounts.disconnectedAt),
            notInArray(
              modelProviderAccounts.id,
              db.select({ id: retained.id }).from(retained),
            ),
          ),
        )
        .returning({ id: modelProviderAccounts.id }),
    );
    const replacement = db.$with("replacement_account").as(
      db
        .select({ id: modelProviderAccounts.id })
        .from(modelProviderAccounts)
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, providerId),
            isNull(modelProviderAccounts.disconnectedAt),
            notInArray(modelProviderAccounts.id, ids),
            // Consume both writes before acquiring the active-account index entry.
            gte(
              sql`${db.select({ count: count() }).from(retained)} + ${db.select({ count: count() }).from(deleted)}`,
              0,
            ),
          ),
        )
        .orderBy(
          asc(modelProviderAccounts.needsReconnect),
          asc(modelProviderAccounts.createdAt),
          asc(modelProviderAccounts.id),
        )
        .limit(1),
    );
    const promoted = db.$with("promoted_account").as(
      db
        .update(modelProviderAccounts)
        .set({ isActive: true, updatedAt: disconnectedAt })
        .where(
          and(
            input.promoteReplacement
              ? inArray(
                  modelProviderAccounts.id,
                  db.select({ id: replacement.id }).from(replacement),
                )
              : sql`false`,
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        )
        .returning({ id: modelProviderAccounts.id }),
    );
    const result = await withAccountConflict(
      (async () => {
        await db
          .with(retained, deleted, replacement, promoted)
          .delete(modelProviders)
          .where(
            and(
              eq(modelProviders.id, providerId),
              notExists(
                db
                  .select({ id: modelProviderAccounts.id })
                  .from(modelProviderAccounts)
                  .where(
                    and(
                      eq(modelProviderAccounts.modelProviderId, providerId),
                      notInArray(
                        modelProviderAccounts.id,
                        db.select({ id: deleted.id }).from(deleted),
                      ),
                    ),
                  ),
              ),
            ),
          );
        return undefined;
      })(),
    );
    signal.throwIfAborted();
    return result;
  },
);

/** Profile/KMS preparation precedes the atomic local disconnection. */
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
        ? await set(prepareClaudeAccountIdentities$, args, signal)
        : null;
    signal.throwIfAborted();
    const result = await set(
      commitPersonalAccountDisconnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        accounts,
        identities,
        providerId,
        promoteReplacement: args.selection.kind === "account" && first.isActive,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result === undefined) {
      await publishPersonalModelProvidersChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

/** Exact management reads never enumerate, seed, or substitute a sibling. */
export function personalModelProviderAccountResponseById(
  scope$: Computed<{
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
  }>,
) {
  return computed(async (get): Promise<ModelProviderResponse | null> => {
    const args = get(scope$);
    const [row] = await get(db$)
      .select({ account: modelProviderAccounts, provider: providerColumns })
      .from(modelProviderAccounts)
      .innerJoin(
        modelProviders,
        eq(modelProviderAccounts.modelProviderId, modelProviders.id),
      )
      .where(
        exactConnectedPersonalAccountCondition({
          id: args.id,
          orgId: args.orgId,
          userId: args.userId,
        }),
      )
      .limit(1);
    const current = row ?? null;
    return current && isPersonalSubscriptionProviderType(current.account.type)
      ? accountResponse(current)
      : null;
  });
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

export interface PersonalSubscriptionCredentialScope {
  readonly orgId: string;
  readonly userId: string;
  readonly type: PersonalSubscriptionProviderType;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly sourceId?: string;
  readonly runId?: string;
}

/** One non-locking statement for the exact account and its whole ciphertext
 * bundle. Callers execute it and decrypt afterwards, outside a transaction. */
export function personalSubscriptionAccountCiphertextsReadPlan(
  args: Omit<PersonalSubscriptionCredentialScope, "featureSwitchContext"> & {
    readonly sourceId: string;
  },
) {
  return {
    columns: {
      account: modelProviderAccounts,
      secret: {
        name: modelProviderAccountSecrets.name,
        encryptedValue: modelProviderAccountSecrets.encryptedValue,
      },
    },
    from: modelProviderAccounts,
    join: {
      table: modelProviderAccountSecrets,
      on: eq(
        modelProviderAccountSecrets.modelProviderAccountId,
        modelProviderAccounts.id,
      ),
    },
    where: and(
      eq(modelProviderAccounts.id, args.sourceId),
      personalSubscriptionAccountAccessCondition(args.runId),
      eq(modelProviderAccounts.orgId, args.orgId),
      eq(modelProviderAccounts.userId, args.userId),
      eq(modelProviderAccounts.type, args.type),
    ),
  };
}

export interface PersonalSubscriptionAccountCiphertexts {
  readonly account: AccountRow;
  readonly secrets: readonly {
    readonly name: string;
    readonly encryptedValue: string;
  }[];
}

export function personalSubscriptionAccountCiphertextsFromRows(
  rows: readonly {
    readonly account: AccountRow;
    readonly secret: {
      readonly name: string;
      readonly encryptedValue: string;
    } | null;
  }[],
): PersonalSubscriptionAccountCiphertexts | null {
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

export async function personalSubscriptionCredentialValues(
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

export type PersonalSubscriptionCredentialBundle = {
  account: AccountRow;
  values: Awaited<ReturnType<typeof personalSubscriptionCredentialValues>>;
} | null;
