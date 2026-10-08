import { command, computed, state } from "ccstate";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { subscriptionUsageWindows } from "../../lib/subscription-usage-windows.ts";
import { refreshPersonalModelProvidersIfStale$ } from "../external/personal-model-providers.ts";
import { personalConfiguredProviders$ } from "./settings/personal-model-providers.ts";

export type AccountMenuSubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
export type AccountMenuSubscriptionUsageWindow = NonNullable<
  AccountMenuSubscriptionUsage["fiveHour"]
>;

export interface AccountMenuSubscriptionUsageRow {
  readonly type: ModelProviderType;
  readonly usage: AccountMenuSubscriptionUsage;
  readonly resetCredits?: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
}

export type AccountMenuSubscriptionUsageRowsCacheKey = string | null;

export const ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS = [
  { type: "codex-oauth-token" },
  { type: "claude-code-oauth-token" },
] as const satisfies readonly {
  readonly type: ModelProviderType;
}[];

interface AccountMenuSubscriptionUsageRowsCache {
  readonly key: AccountMenuSubscriptionUsageRowsCacheKey;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[] | null;
}

const internalAccountMenuSubscriptionUsageRowsRequestId$ = state(0);
const internalAccountMenuSubscriptionUsageRowsRefreshPromise$ =
  state<Promise<void> | null>(null);
const internalAccountMenuSubscriptionUsageRowsCache$ =
  state<AccountMenuSubscriptionUsageRowsCache>({
    key: null,
    rows: null,
  });

export const accountMenuSubscriptionUsageRowsCache$ = computed((get) => {
  return get(internalAccountMenuSubscriptionUsageRowsCache$);
});

export const accountMenuSubscriptionUsageRowsRefreshPromise$ = computed(
  (get) => {
    return get(internalAccountMenuSubscriptionUsageRowsRefreshPromise$);
  },
);

export const reloadAccountMenuSubscriptionUsageRows$ = command(
  (
    { get, set },
    key: AccountMenuSubscriptionUsageRowsCacheKey,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const requestId =
      get(internalAccountMenuSubscriptionUsageRowsRequestId$) + 1;
    set(internalAccountMenuSubscriptionUsageRowsRequestId$, requestId);

    const promise = (async () => {
      set(refreshPersonalModelProvidersIfStale$);
      const providers = await get(personalConfiguredProviders$);
      signal.throwIfAborted();
      if (
        get(internalAccountMenuSubscriptionUsageRowsRequestId$) !== requestId
      ) {
        return;
      }
      const rows = accountMenuSubscriptionUsageRows(providers);
      set(internalAccountMenuSubscriptionUsageRowsCache$, { key, rows });
    })();

    set(internalAccountMenuSubscriptionUsageRowsRefreshPromise$, promise);

    return promise;
  },
);

export function accountMenuSubscriptionUsageRows(
  providers: readonly ModelProviderResponse[],
): readonly AccountMenuSubscriptionUsageRow[] {
  return ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.flatMap((definition) => {
    const provider = providers.find((candidate) => {
      return candidate.type === definition.type;
    });
    if (!provider) {
      return [];
    }
    const usage = fallbackSubscriptionUsage(provider);
    if (!usage || subscriptionUsageWindows(usage).length === 0) {
      return [];
    }
    return [
      {
        type: definition.type,
        usage,
        ...(provider.type !== "codex-oauth-token" ||
        provider.subscriptionResetCredits === undefined
          ? {}
          : {
              resetCredits: provider.subscriptionResetCredits,
              resetCreditsNextExpiresAt:
                provider.subscriptionResetCreditsNextExpiresAt ?? null,
            }),
      },
    ];
  });
}

function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): AccountMenuSubscriptionUsage | null {
  if (subscriptionUsageWindows(provider.subscriptionUsage).length > 0) {
    return provider.subscriptionUsage ?? null;
  }

  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };

  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}
