import { command } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { secrets } from "@okouai/db/schema/secret";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  invalidateCodexResetCreditExpiry,
  prepareCodexResetCreditExpiryRead,
} from "./codex-reset-credit-expiry.service";
import { logger } from "../../lib/log";
import { type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { tapError } from "../utils";
import { resolveCurrentModelProviderRuntimeSecretForApi } from "./agent-webhook-firewall-auth.service";
import { fetchClaudeCodeSubscriptionMetadata } from "./claude-code-usage.service";
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexUsageMetadata,
  type CodexRateLimitResetCreditOutcome,
} from "./codex-usage.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import type {
  SubscriptionUsageMetadata,
  SubscriptionUsageWindowMetadata,
} from "./model-provider-subscription-usage.types";

const L = logger("model-provider-subscription-usage.service");

const CODEX_USAGE_METADATA_SECRET_NAMES = [
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_ID_TOKEN",
] as const;
const CODEX_RESET_METADATA_SECRET_NAMES = ["CHATGPT_ACCOUNT_ID"] as const;
const CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";

interface SubscriptionMetadata {
  readonly accountEmail?: string | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
  readonly subscriptionUsage?: SubscriptionUsageMetadata | null;
  readonly subscriptionResetCredits?: number | null;
  readonly subscriptionResetCreditsNextExpiresAt?: Date | null;
}

type SerializedSubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;

async function modelProviderSecretValues(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly modelProviderAccountId?: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  if (args.names.length === 0) {
    return new Map();
  }

  const rows = args.modelProviderAccountId
    ? await args.db
        .select({
          name: modelProviderAccountSecrets.name,
          encryptedValue: modelProviderAccountSecrets.encryptedValue,
        })
        .from(modelProviderAccountSecrets)
        .innerJoin(
          modelProviderAccounts,
          eq(
            modelProviderAccountSecrets.modelProviderAccountId,
            modelProviderAccounts.id,
          ),
        )
        .where(
          and(
            eq(
              modelProviderAccountSecrets.modelProviderAccountId,
              args.modelProviderAccountId,
            ),
            inArray(modelProviderAccountSecrets.name, [...args.names]),
            eq(modelProviderAccounts.orgId, args.orgId),
            eq(modelProviderAccounts.userId, args.userId),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        )
    : await args.db
        .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, args.orgId),
            eq(secrets.userId, args.userId),
            eq(secrets.type, "model-provider"),
            inArray(secrets.name, [...args.names]),
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
    signal.throwIfAborted();
  }
  return values;
}

function serializeUsageWindow(
  window: SubscriptionUsageWindowMetadata | null,
): SerializedSubscriptionUsage["fiveHour"] {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt?.toISOString() ?? null,
    windowSeconds: window.windowSeconds,
  };
}

function serializeSubscriptionUsage(
  usage: SubscriptionUsageMetadata | null | undefined,
): SerializedSubscriptionUsage | null {
  if (!usage) {
    return null;
  }

  const fiveHour = serializeUsageWindow(usage.fiveHour);
  const weekly = serializeUsageWindow(usage.weekly);
  if (!fiveHour && !weekly) {
    return null;
  }

  return {
    fiveHour,
    weekly,
  };
}

function withSubscriptionMetadata(
  provider: ModelProviderResponse,
  metadata: SubscriptionMetadata | null | undefined,
): ModelProviderResponse {
  if (!metadata) {
    return provider;
  }

  return {
    ...provider,
    accountEmail: metadata.accountEmail ?? provider.accountEmail,
    workspaceName: metadata.workspaceName ?? provider.workspaceName,
    planType: metadata.planType ?? provider.planType,
    subscriptionResetPeriod:
      metadata.subscriptionResetPeriod ?? provider.subscriptionResetPeriod,
    subscriptionNextResetAt:
      metadata.subscriptionNextResetAt?.toISOString() ??
      provider.subscriptionNextResetAt,
    subscriptionUsage: serializeSubscriptionUsage(metadata.subscriptionUsage),
    subscriptionResetCredits:
      metadata.subscriptionResetCredits ?? provider.subscriptionResetCredits,
    // No column backs this field, so there is no stored value to fall back to:
    // an absent expiry is reported as such rather than deferred to the row.
    subscriptionResetCreditsNextExpiresAt:
      metadata.subscriptionResetCreditsNextExpiresAt?.toISOString() ?? null,
  };
}

async function refreshCodexProvider(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ModelProviderResponse;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ModelProviderResponse> {
  const readResetCreditExpiry = prepareCodexResetCreditExpiryRead(
    { scope: "personal", orgId: args.orgId, userId: args.userId },
    args.provider.modelProviderId ? args.provider.id : null,
  );
  const accountMetadata = {
    sourceType: "model-provider" as const,
    sourceUserId: args.userId,
    ...(args.provider.modelProviderId ? { sourceId: args.provider.id } : {}),
    metadataKey: args.provider.type,
  };
  const [accessTokenResult, secretValues] = await Promise.all([
    resolveCurrentModelProviderRuntimeSecretForApi(
      {
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        key: "CHATGPT_ACCESS_TOKEN",
        providerKey: args.provider.type,
        metadata: accountMetadata,
        featureSwitchContext: args.featureSwitchContext,
      },
      signal,
    ),
    modelProviderSecretValues(
      {
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        names: CODEX_USAGE_METADATA_SECRET_NAMES,
        ...(args.provider.modelProviderId
          ? { modelProviderAccountId: args.provider.id }
          : {}),
        featureSwitchContext: args.featureSwitchContext,
      },
      signal,
    ),
  ]);
  signal.throwIfAborted();
  if (accessTokenResult.status === "unavailable") {
    return accessTokenResult.reconnectState
      ? {
          ...args.provider,
          needsReconnect: accessTokenResult.reconnectState.needsReconnect,
          lastRefreshErrorCode:
            accessTokenResult.reconnectState.lastRefreshErrorCode,
        }
      : args.provider;
  }

  const accountId = secretValues.get("CHATGPT_ACCOUNT_ID");
  const idToken = secretValues.get("CHATGPT_ID_TOKEN");
  if (!accountId) {
    return args.provider;
  }

  const metadata = await fetchCodexUsageMetadata(
    {
      accessToken: accessTokenResult.value,
      accountId,
      idToken,
      readResetCreditExpiry,
    },
    signal,
  );

  return withSubscriptionMetadata(args.provider, metadata);
}

async function refreshClaudeCodeProvider(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ModelProviderResponse;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ModelProviderResponse> {
  const secretValues = await modelProviderSecretValues(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      names: [CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME],
      ...(args.provider.modelProviderId
        ? { modelProviderAccountId: args.provider.id }
        : {}),
      featureSwitchContext: args.featureSwitchContext,
    },
    signal,
  );
  const accessToken = secretValues.get(CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME);
  if (!accessToken) {
    return args.provider;
  }

  const metadata = await fetchClaudeCodeSubscriptionMetadata(
    {
      accessToken,
    },
    signal,
  );

  return withSubscriptionMetadata(args.provider, metadata);
}

async function refreshProvider(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ModelProviderResponse;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<ModelProviderResponse> {
  if (args.provider.type === "codex-oauth-token") {
    return await refreshCodexProvider(args, signal);
  }
  if (args.provider.needsReconnect) {
    return args.provider;
  }
  if (args.provider.type === "claude-code-oauth-token") {
    return await refreshClaudeCodeProvider(args, signal);
  }
  return args.provider;
}

export const refreshPersonalModelProviderSubscriptionUsage$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly result: ModelProviderListResponse;
    },
    signal: AbortSignal,
  ): Promise<ModelProviderListResponse> => {
    if (args.result.modelProviders.length === 0) {
      return args.result;
    }

    const database = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const refreshed = await Promise.all(
      args.result.modelProviders.map(async (provider) => {
        return (
          (await tapError(
            refreshProvider(
              {
                db: database,
                orgId: args.orgId,
                userId: args.userId,
                provider,
                featureSwitchContext,
              },
              signal,
            ),
            (error) => {
              signal.throwIfAborted();
              L.warn(
                "failed to refresh personal model provider subscription usage",
                {
                  error,
                  ...(provider.modelProviderId
                    ? { modelProviderAccountId: provider.id }
                    : {}),
                  orgId: args.orgId,
                  providerType: provider.type,
                  userId: args.userId,
                },
              );
            },
          )) ?? provider
        );
      }),
    );
    signal.throwIfAborted();

    return {
      modelProviders: refreshed,
    };
  },
);

type NotFoundResponse = ReturnType<typeof notFound>;

export const consumePersonalCodexRateLimitResetCredit$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly idempotencyKey: string;
      readonly modelProviderAccountId?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: CodexRateLimitResetCreditOutcome;
      }
    | NotFoundResponse
  > => {
    const database = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const secretValues = await modelProviderSecretValues(
      {
        db: database,
        orgId: args.orgId,
        userId: args.userId,
        names: CODEX_RESET_METADATA_SECRET_NAMES,
        modelProviderAccountId: args.modelProviderAccountId,
        featureSwitchContext,
      },
      signal,
    );
    const accountId = secretValues.get("CHATGPT_ACCOUNT_ID");
    if (!accountId) {
      return notFound("Resource not found");
    }

    const accessTokenResult =
      await resolveCurrentModelProviderRuntimeSecretForApi(
        {
          db: database,
          orgId: args.orgId,
          userId: args.userId,
          key: "CHATGPT_ACCESS_TOKEN",
          providerKey: "codex-oauth-token",
          metadata: {
            sourceType: "model-provider",
            sourceUserId: args.userId,
            ...(args.modelProviderAccountId
              ? { sourceId: args.modelProviderAccountId }
              : {}),
            metadataKey: "codex-oauth-token",
          },
          featureSwitchContext,
        },
        signal,
      );
    signal.throwIfAborted();
    if (accessTokenResult.status === "unavailable") {
      if (!accessTokenResult.reconnectState) {
        return notFound("Resource not found");
      }
      throw new Error(
        "Codex access token unavailable for reset-credit request",
      );
    }

    const invalidateExpiry = () => {
      invalidateCodexResetCreditExpiry(
        { scope: "personal", orgId: args.orgId, userId: args.userId },
        { binding: args.modelProviderAccountId ?? null },
      );
    };
    invalidateExpiry();
    return await consumeCodexRateLimitResetCredit(
      {
        accessToken: accessTokenResult.value,
        accountId,
        idempotencyKey: args.idempotencyKey,
      },
      signal,
    ).finally(invalidateExpiry);
  },
);
