import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  getModelProviderPresentationLabel,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ResetPersonalModelProviderSubscriptionUsageResponse } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  activatePersonalModelProviderAccount$,
  deletePersonalModelProviderAccount$,
  deletePersonalModelProvider$,
  personalModelProviders$,
  resetPersonalCodexAccountSubscriptionUsage$ as resetPersonalCodexAccountSubscriptionUsageRequest$,
  resetPersonalCodexSubscriptionUsage$ as resetPersonalCodexSubscriptionUsageRequest$,
} from "../../external/personal-model-providers.ts";
import { i18n } from "../../../i18n/index.ts";

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalPersonalActionPromise$ = state<Promise<unknown> | null>(null);
const internalSettingsCodexResetDialog$ = state({
  open: false,
  resetCredits: null as number | null,
  accountId: null as string | null,
  type: "codex-oauth-token" as ModelProviderType,
});
const internalAccountMenuCodexResetDialog$ = state({
  open: false,
  resetCredits: null as number | null,
  type: "codex-oauth-token" as ModelProviderType,
});
interface PersonalAccountDisconnectDialogState {
  readonly account: ModelProviderResponse;
  readonly fallbackIndex: number;
}

const internalPersonalAccountDisconnectDialog$ =
  state<PersonalAccountDisconnectDialogState | null>(null);

export const personalActionPromise$ = computed((get) => {
  return get(internalPersonalActionPromise$);
});

export const settingsCodexResetDialog$ = computed((get) => {
  return get(internalSettingsCodexResetDialog$);
});

export const accountMenuCodexResetDialog$ = computed((get) => {
  return get(internalAccountMenuCodexResetDialog$);
});

export const personalAccountDisconnectDialog$ = computed((get) => {
  return get(internalPersonalAccountDisconnectDialog$);
});

export const setSettingsCodexResetDialog$ = command(
  (
    { set },
    dialog: {
      open: boolean;
      resetCredits: number | null;
      accountId: string | null;
      type: ModelProviderType;
    },
  ) => {
    set(internalSettingsCodexResetDialog$, dialog);
  },
);

export const setAccountMenuCodexResetDialog$ = command(
  (
    { set },
    dialog: {
      open: boolean;
      resetCredits: number | null;
      type: ModelProviderType;
    },
  ) => {
    set(internalAccountMenuCodexResetDialog$, dialog);
  },
);

export const setPersonalAccountDisconnectDialog$ = command(
  ({ set }, dialog: PersonalAccountDisconnectDialogState | null) => {
    set(internalPersonalAccountDisconnectDialog$, dialog);
  },
);

/**
 * Display name for a subscription whose usage can be reset. The reset copy is
 * shared by every such provider, so the name is a parameter rather than a
 * separate string per provider.
 */
export function subscriptionResetProviderLabel(
  type: ModelProviderType,
): string {
  return i18n.t(($) => {
    return type === "codex-oauth-token"
      ? $.settings.accountMenu.subscriptions.providers.codex
      : $.settings.accountMenu.subscriptions.providers.claudeCode;
  });
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const personalConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(personalModelProviders$);
  return [...modelProviders].sort((a, b) => {
    if (a.type === b.type && a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});

export const disconnectPersonalOAuthCredential$ = command(
  async ({ set }, providerType: ModelProviderType, signal: AbortSignal) => {
    const providerLabel = getModelProviderPresentationLabel(providerType);

    const promise = (async () => {
      await set(deletePersonalModelProvider$, providerType, signal);
      signal.throwIfAborted();
      toast.success(
        i18n.t(
          ($) => {
            return $.settings.models.toasts.disconnected;
          },
          {
            provider: providerLabel,
          },
        ),
      );
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

export const activatePersonalOAuthCredentialAccount$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const promise = (async () => {
      await set(activatePersonalModelProviderAccount$, id, signal);
      signal.throwIfAborted();
      toast.success(
        i18n.t(($) => {
          return $.settings.models.toasts.accountSwitched;
        }),
      );
    })();
    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });
    await promise;
    signal.throwIfAborted();
  },
);

export const deletePersonalOAuthCredentialAccount$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const promise = (async () => {
      await set(deletePersonalModelProviderAccount$, id, signal);
      signal.throwIfAborted();
      toast.success(
        i18n.t(($) => {
          return $.settings.models.toasts.accountDisconnected;
        }),
      );
    })();
    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });
    await promise;
    signal.throwIfAborted();
  },
);

const runPersonalCodexSubscriptionUsageReset$ = command(
  async (
    { set },
    args: {
      readonly type: ModelProviderType;
      readonly request: () => Promise<ResetPersonalModelProviderSubscriptionUsageResponse>;
    },
    signal: AbortSignal,
  ) => {
    const provider = subscriptionResetProviderLabel(args.type);
    const promise = (async () => {
      const result = await args.request();
      signal.throwIfAborted();

      switch (result.outcome) {
        case "reset":
        case "alreadyRedeemed": {
          toast.success(
            i18n.t(
              ($) => {
                return $.settings.models.toasts.reset;
              },
              { provider },
            ),
          );
          break;
        }
        case "nothingToReset": {
          toast.info(
            i18n.t(
              ($) => {
                return $.settings.models.toasts.resetUnneeded;
              },
              { provider },
            ),
          );
          break;
        }
        case "noCredit": {
          toast.error(
            i18n.t(
              ($) => {
                return $.settings.models.toasts.resetUnavailable;
              },
              { provider },
            ),
          );
          break;
        }
      }
      return result;
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    const result = await promise;
    signal.throwIfAborted();
    return result;
  },
);

export const resetPersonalCodexSubscriptionUsage$ = command(
  ({ set }, type: ModelProviderType, signal: AbortSignal) => {
    return set(
      runPersonalCodexSubscriptionUsageReset$,
      {
        type,
        request: () => {
          return set(
            resetPersonalCodexSubscriptionUsageRequest$,
            { type, idempotencyKey: crypto.randomUUID() },
            signal,
          );
        },
      },
      signal,
    );
  },
);

export const resetPersonalCodexAccountSubscriptionUsage$ = command(
  (
    { set },
    target: {
      readonly type: ModelProviderType;
      readonly account:
        | string
        | { readonly id: string; readonly runId: string };
    },
    signal: AbortSignal,
  ) => {
    const account =
      typeof target.account === "string"
        ? { id: target.account }
        : target.account;
    return set(
      runPersonalCodexSubscriptionUsageReset$,
      {
        type: target.type,
        request: () => {
          return set(
            resetPersonalCodexAccountSubscriptionUsageRequest$,
            { ...account, idempotencyKey: crypto.randomUUID() },
            signal,
          );
        },
      },
      signal,
    );
  },
);
