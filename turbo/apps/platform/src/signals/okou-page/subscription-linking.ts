import type {
  ModelProviderResponse,
  PersonalSubscriptionProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
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
  "composer_model_slot" | "composer_model_panel" | "account_menu" | "me_page";

/** Both subscriptions, in the order every entry lists them. */
export const SUBSCRIPTION_PROVIDERS: readonly PersonalSubscriptionProviderType[] =
  ["codex-oauth-token", "claude-code-oauth-token"];

export interface SubscriptionPlanStatus {
  readonly type: PersonalSubscriptionProviderType;
  readonly linked: boolean;
  /** The tighter usage window of the active account, when it is reported. */
  readonly remainingPercent: number | null;
}

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

function remainingPercent(
  account: ModelProviderResponse | undefined,
): number | null {
  const windows = [
    account?.subscriptionUsage?.fiveHour?.remainingPercent,
    account?.subscriptionUsage?.weekly?.remainingPercent,
  ].filter((value): value is number => {
    return typeof value === "number";
  });
  return windows.length === 0 ? null : Math.min(...windows);
}

/**
 * Each subscription, linked or not, so the model panel can keep an entry for
 * the one still missing instead of reading as if only one can be linked.
 */
export const subscriptionPlanStatuses$ = computed(async (get) => {
  if (!get(subscriptionLinkingEnabled$)) {
    return null;
  }
  const { modelProviders } = await get(personalModelProviders$);
  return SUBSCRIPTION_PROVIDERS.map((type): SubscriptionPlanStatus => {
    const accounts = modelProviders.filter((account) => {
      return account.type === type;
    });
    const active = accounts.find((account) => {
      return account.isActive !== false;
    });
    return {
      type,
      linked: accounts.length > 0,
      remainingPercent: remainingPercent(active),
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

/** Me and the model panel's Manage plans open Models, which lists both. */
export const openSubscriptionLinkingSettings$ = command(
  async (
    { set },
    source: "me_page" | "composer_model_panel",
    signal: AbortSignal,
  ) => {
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("entry_clicked", source);
    await set(openSettingsDialogAt$, "model", signal);
  },
);
