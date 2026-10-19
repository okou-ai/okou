import type { PersonalSubscriptionProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { captureSubscriptionLinkingEvent } from "../../lib/posthog.ts";
import { limitingSubscriptionUsageWindow } from "../../lib/subscription-usage-windows.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { thirdPartySubscriptions$ } from "../external/third-party-subscriptions.ts";
import { setSidebarExpanded$ } from "./nav.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

export type SubscriptionLinkingSource =
  "composer_model_slot" | "composer_model_panel" | "account_menu" | "me_page";

/** Both subscriptions, in the order every entry lists them. */
export const SUBSCRIPTION_PROVIDERS: readonly PersonalSubscriptionProviderType[] =
  ["codex-oauth-token", "claude-code-oauth-token"];

interface SubscriptionPlanUsage {
  readonly type: PersonalSubscriptionProviderType;
  /** The tighter usage window of the active account, when it is reported. */
  readonly remainingPercent: number | null;
  /** Which window `remainingPercent` belongs to, so the caption can name it. */
  readonly limitingWindow: "fiveHour" | "week" | null;
}

export const subscriptionLinkingEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.SubscriptionLinkingEntry];
});

export const subscriptionLinkingUnlinked$ = computed(async (get) => {
  if (!get(subscriptionLinkingEnabled$)) {
    return null;
  }
  const { subscriptions } = await get(thirdPartySubscriptions$);
  return subscriptions.length === 0;
});

/** Usage is read only by the model panel's quota leaves, never its structure. */
export const subscriptionPlanUsage$ = computed(async (get) => {
  const { subscriptions } = await get(thirdPartySubscriptions$);
  return SUBSCRIPTION_PROVIDERS.map((type): SubscriptionPlanUsage => {
    const active = subscriptions.find((account) => {
      return account.type === type && account.isActive !== false;
    });
    const limiting = limitingSubscriptionUsageWindow(active?.subscriptionUsage);
    const remainingPercent = limiting?.remainingPercent ?? null;
    return {
      type,
      remainingPercent,
      limitingWindow:
        limiting !== null && remainingPercent !== null ? limiting.kind : null,
    };
  });
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

/** The model panel's Manage plans opens Models, which lists both. */
export const openSubscriptionLinkingSettings$ = command(
  async ({ set }, source: "composer_model_panel", signal: AbortSignal) => {
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("entry_clicked", source);
    await set(openSettingsDialogAt$, "model", signal);
  },
);
