import { command } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import {
  invalidateCodexResetCreditExpiry,
  prepareCodexResetCreditExpiryRead,
} from "./codex-reset-credit-expiry.service";
import { logger } from "../../lib/log";
import { type Db, writeDb$ } from "../external/db";
import { publishPersonalModelProvidersChangedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { tapError } from "../utils";
import { resolveCurrentPersonalSubscriptionBundleForApi } from "./agent-webhook-firewall-auth.service";
import { fetchClaudeCodeSubscriptionMetadata } from "./claude-code-usage.service";
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexUsageMetadata,
  type CodexRateLimitResetCreditOutcome,
} from "./codex-usage.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import type {
  SubscriptionUsageMetadata,
  SubscriptionUsageWindowMetadata,
} from "./model-provider-subscription-usage.types";
import { personalModelProviderAccountById } from "./model-provider-account.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";

const L = logger("model-provider-subscription-usage.service");

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
    readonly expectedAccountIdentity?: string;
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
  const accessTokenResult =
    await resolveCurrentPersonalSubscriptionBundleForApi(
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
    );
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

  const accountId = accessTokenResult.values.get("CHATGPT_ACCOUNT_ID");
  const idToken = accessTokenResult.values.get("CHATGPT_ID_TOKEN");
  const accessToken = accessTokenResult.values.get("CHATGPT_ACCESS_TOKEN");
  if (!accountId || !accessToken) {
    return args.provider;
  }
  if (
    args.expectedAccountIdentity &&
    personalSubscriptionAccountIdentity({
      type: args.provider.type,
      externalAccountId: accountId,
      accountEmail: null,
      workspaceName: null,
    }) !== args.expectedAccountIdentity
  ) {
    return args.provider;
  }

  const metadata = await fetchCodexUsageMetadata(
    {
      accessToken,
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
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ModelProviderResponse;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly expectedAccountIdentity?: string;
  },
  signal: AbortSignal,
): Promise<ModelProviderResponse> {
  const bundle = await resolveCurrentPersonalSubscriptionBundleForApi(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      key: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
      providerKey: args.provider.type,
      metadata: {
        sourceType: "model-provider",
        sourceUserId: args.userId,
        metadataKey: args.provider.type,
        ...(args.provider.modelProviderId
          ? { sourceId: args.provider.id }
          : {}),
      },
      featureSwitchContext: args.featureSwitchContext,
    },
    signal,
  );
  const accessToken =
    bundle.status === "available"
      ? bundle.values.get(CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME)
      : undefined;
  if (!accessToken) {
    return args.provider;
  }
  if (args.expectedAccountIdentity) {
    const account = await personalModelProviderAccountById({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      id: args.provider.id,
    });
    if (
      !account ||
      personalSubscriptionAccountIdentity(account) !==
        args.expectedAccountIdentity
    ) {
      return args.provider;
    }
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
    readonly expectedAccountIdentity?: string;
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
      readonly expectedAccountIdentity?: string;
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
                expectedAccountIdentity: args.expectedAccountIdentity,
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
      readonly expectedAccountIdentity?: string;
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

    const accessTokenResult =
      await resolveCurrentPersonalSubscriptionBundleForApi(
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

    const accountId = accessTokenResult.values.get("CHATGPT_ACCOUNT_ID");
    const accessToken = accessTokenResult.values.get("CHATGPT_ACCESS_TOKEN");
    if (!accountId || !accessToken) {
      return notFound("Resource not found");
    }
    if (
      args.expectedAccountIdentity &&
      personalSubscriptionAccountIdentity({
        type: "codex-oauth-token",
        externalAccountId: accountId,
        accountEmail: null,
        workspaceName: null,
      }) !== args.expectedAccountIdentity
    ) {
      return notFound("Resource not found");
    }

    const invalidateExpiry = () => {
      invalidateCodexResetCreditExpiry(
        { scope: "personal", orgId: args.orgId, userId: args.userId },
        { binding: args.modelProviderAccountId ?? null },
      );
    };
    invalidateExpiry();
    const result = await consumeCodexRateLimitResetCredit(
      {
        accessToken,
        accountId,
        idempotencyKey: args.idempotencyKey,
      },
      signal,
    ).finally(invalidateExpiry);
    signal.throwIfAborted();
    await publishPersonalModelProvidersChangedSafely(args.userId);
    signal.throwIfAborted();
    return result;
  },
);
