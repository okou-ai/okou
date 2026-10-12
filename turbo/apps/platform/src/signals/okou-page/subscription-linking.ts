import type { PersonalSubscriptionProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { captureSubscriptionLinkingEvent } from "../../lib/posthog.ts";
import { user$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  personalModelProviders$,
  refreshPersonalModelProvidersIfStale$,
} from "../external/personal-model-providers.ts";
import { onRef } from "../utils.ts";
import { setSidebarExpanded$ } from "./nav.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

type SubscriptionLinkingSource = "composer_hint" | "account_menu";

export const subscriptionLinkingEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.SubscriptionLinkingEntry];
});

export const subscriptionLinkingUnlinked$ = computed(async (get) => {
  if (!get(subscriptionLinkingEnabled$)) {
    return null;
  }
  const { modelProviders } = await get(personalModelProviders$);
  return modelProviders.length === 0;
});

const hintDismissalStorage$ = computed(async (get) => {
  const user = await get(user$);
  return user
    ? localStorageSignals(`subscription-hint-dismissed:${user.id}`)
    : null;
});

export const subscriptionLinkingHintVisible$ = computed(async (get) => {
  if (!get(subscriptionLinkingEnabled$)) {
    return false;
  }
  const storage = await get(hintDismissalStorage$);
  if (!storage || get(storage.get$) === "1") {
    return false;
  }
  return (await get(subscriptionLinkingUnlinked$)) === true;
});

export const dismissSubscriptionLinkingHint$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const storage = await get(hintDismissalStorage$);
    signal.throwIfAborted();
    if (storage) {
      set(storage.set$, "1");
      captureSubscriptionLinkingEvent("hint_dismissed", "composer_hint");
    }
  },
);

export const subscriptionLinkingHintRef$ = onRef(
  command((_, element: HTMLElement, signal: AbortSignal) => {
    const observer = new IntersectionObserver((entries) => {
      if (
        entries.some((entry) => {
          return entry.isIntersecting;
        })
      ) {
        captureSubscriptionLinkingEvent("hint_viewed", "composer_hint");
        observer.disconnect();
      }
    });
    observer.observe(element);
    signal.addEventListener("abort", () => {
      return observer.disconnect();
    });
  }),
);

const internalSubscriptionLinkingSource$ =
  state<SubscriptionLinkingSource | null>(null);

export const subscriptionLinkingSource$ = computed((get) => {
  return get(internalSubscriptionLinkingSource$);
});

export const openSubscriptionLinking$ = command(
  ({ set }, source: SubscriptionLinkingSource) => {
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("entry_clicked", source);
    set(refreshPersonalModelProvidersIfStale$);
    set(internalSubscriptionLinkingSource$, source);
  },
);

export const closeSubscriptionLinking$ = command(({ set }) => {
  set(internalSubscriptionLinkingSource$, null);
});

export const connectSubscriptionLinkingProvider$ = command(
  async (
    { get, set },
    provider: PersonalSubscriptionProviderType,
    signal: AbortSignal,
  ) => {
    const source = get(internalSubscriptionLinkingSource$);
    if (!source || !get(subscriptionLinkingEnabled$)) {
      return;
    }
    captureSubscriptionLinkingEvent("provider_selected", source, provider);
    set(closeSubscriptionLinking$);
    signal.throwIfAborted();
    const args = { mode: "connect" as const };
    if (provider === "codex-oauth-token") {
      await set(openCodexDeviceAuthDialogPersonal$, args, signal);
      return;
    }
    await set(openClaudeCodeDeviceAuthDialogPersonal$, args, signal);
  },
);

export const manageLinkedSubscriptions$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("manage_opened", "account_menu");
    await set(openSettingsDialogAt$, "model", signal);
  },
);
