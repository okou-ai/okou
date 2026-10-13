import type { PersonalSubscriptionProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { captureSubscriptionLinkingEvent } from "../../lib/posthog.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { setSidebarExpanded$ } from "./nav.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

export type SubscriptionLinkingSource =
  "composer_model_slot" | "account_menu" | "me_page";

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

export const trackSubscriptionLinkingOpened$ = command(
  (_, source: SubscriptionLinkingSource) => {
    captureSubscriptionLinkingEvent("entry_clicked", source);
  },
);

/** Every entry names the provider itself, so it opens that provider's sign-in. */
export const connectSubscriptionLinkingProvider$ = command(
  async (
    { get, set },
    source: SubscriptionLinkingSource,
    provider: PersonalSubscriptionProviderType,
    signal: AbortSignal,
  ) => {
    if (!get(subscriptionLinkingEnabled$)) {
      return;
    }
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("provider_selected", source, provider);
    const args = { mode: "connect" as const };
    if (provider === "codex-oauth-token") {
      await set(openCodexDeviceAuthDialogPersonal$, args, signal);
      return;
    }
    await set(openClaudeCodeDeviceAuthDialogPersonal$, args, signal);
  },
);

/** Me has no submenu, so it opens Models, which lists both providers. */
export const openSubscriptionLinkingSettings$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("entry_clicked", "me_page");
    await set(openSettingsDialogAt$, "model", signal);
  },
);
