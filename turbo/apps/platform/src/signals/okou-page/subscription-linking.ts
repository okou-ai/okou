import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type {
  ModelProviderResponse,
  PersonalSubscriptionProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { command, computed, type Command } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { captureSubscriptionLinkingEvent } from "../../lib/posthog.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { modelCatalog$ } from "../external/model-catalog.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn } from "../utils.ts";
import { PERSONAL_SUBSCRIPTION_CONNECTED_TOAST_ID } from "./model-first-personal-oauth.ts";
import { setSidebarExpanded$ } from "./nav.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

export type SubscriptionLinkingSource =
  "composer_model_slot" | "composer_model_panel" | "account_menu" | "me_page";

/** Both subscriptions, in the order every entry lists them. */
export const SUBSCRIPTION_PROVIDERS: readonly PersonalSubscriptionProviderType[] =
  ["codex-oauth-token", "claude-code-oauth-token"];

/** A composer's model setter, so a connect it started can switch its model. */
export type SubscriptionLinkingModelSelect = Command<
  Promise<void>,
  [ModelProviderSelection | null, AbortSignal]
>;

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
    const active =
      accounts.find((account) => {
        return account.isActive === true;
      }) ?? accounts[0];
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

function connectedOnPlanMessage(provider: PersonalSubscriptionProviderType) {
  return provider === "codex-oauth-token"
    ? i18n.t(($) => {
        return $.settings.models.personal.codexConnectedOnPlan;
      })
    : i18n.t(($) => {
        return $.settings.models.personal.claudeConnectedOnPlan;
      });
}

/**
 * Connecting is the member asking to run on that plan, so the composer that
 * started it moves off Auto onto the plan's first model at once; the toast
 * says so and offers the way back.
 */
const selectConnectedPlanModel$ = command(
  async (
    { get, set },
    provider: PersonalSubscriptionProviderType,
    select$: SubscriptionLinkingModelSelect,
    signal: AbortSignal,
  ) => {
    const [{ models }, catalog] = await Promise.all([
      get(availableRunModels$),
      get(modelCatalog$),
    ]);
    signal.throwIfAborted();
    const planModel = models
      .filter((runModel) => {
        return (
          runModel.model !== null &&
          runModel.memberEffective.providerType === provider &&
          runModel.memberEffective.credentialScope === "member" &&
          catalog.isActive(runModel.model) &&
          isMemberRunModelConfigurable(runModel)
        );
      })
      .map((runModel) => {
        return runModel.model;
      })
      .filter((model): model is string => {
        return model !== null;
      })
      .sort((left, right) => {
        return catalog.compare(left, right);
      })[0];
    if (planModel === undefined) {
      return;
    }
    await set(select$, { selectedModel: planModel }, signal);
    signal.throwIfAborted();
    toast.success(connectedOnPlanMessage(provider), {
      ...TEXT_TOAST_ACTION,
      id: PERSONAL_SUBSCRIPTION_CONNECTED_TOAST_ID,
      action: {
        label: i18n.t(($) => {
          return $.settings.models.personal.useAuto;
        }),
        onClick: onDomEventFn(async () => {
          await set(select$, { selectedModel: null }, get(rootSignal$));
        }),
      },
    });
  },
);

/**
 * Every entry names the provider itself, so it opens that provider's sign-in.
 * A composer entry passes its model setter so the new plan takes over there.
 */
export const connectSubscriptionLinkingProvider$ = command(
  async (
    { get, set },
    source: SubscriptionLinkingSource,
    provider: PersonalSubscriptionProviderType,
    select$: SubscriptionLinkingModelSelect | null,
    signal: AbortSignal,
  ) => {
    if (!get(subscriptionLinkingEnabled$)) {
      return;
    }
    set(setSidebarExpanded$, false);
    captureSubscriptionLinkingEvent("provider_selected", source, provider);
    const args = { mode: "connect" as const };
    const connected =
      provider === "codex-oauth-token"
        ? await set(openCodexDeviceAuthDialogPersonal$, args, signal)
        : await set(openClaudeCodeDeviceAuthDialogPersonal$, args, signal);
    signal.throwIfAborted();
    if (!connected || select$ === null) {
      return;
    }
    await set(selectConnectedPlanModel$, provider, select$, signal);
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
