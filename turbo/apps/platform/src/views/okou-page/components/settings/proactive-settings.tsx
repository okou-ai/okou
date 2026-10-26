import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ProactivePreference as ProactivePreferenceValue,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  proactiveSuggestionsPreference$,
  updateProactiveSuggestionsPreference$,
} from "../../../../signals/okou-page/settings/proactive-suggestions.ts";
import {
  proactiveJobsPreference$,
  updateProactiveJobsPreference$,
} from "../../../../signals/okou-page/settings/proactive-jobs.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";
import { proactiveLearningSignals } from "../../../../signals/okou-page/settings/proactive-nightly.ts";

type ProactivePreferenceKind = Exclude<ProactiveWorkflowKind, "planning">;

function preferenceStatusKey(
  value: ProactivePreferenceValue | undefined,
  failed: boolean,
) {
  return failed
    ? "retryMessage"
    : value?.unavailableReason === "missing-default-agent"
      ? "missingDefaultAgent"
      : value?.unavailableReason === "missing-timezone"
        ? "missingTimezone"
        : value?.status === "preparing"
          ? "preparing"
          : value?.status === "error"
            ? "preparationFailed"
            : null;
}

const PREFERENCE_SIGNALS = {
  jobs: {
    preference$: proactiveJobsPreference$,
    update$: updateProactiveJobsPreference$,
  },
  suggestions: {
    preference$: proactiveSuggestionsPreference$,
    update$: updateProactiveSuggestionsPreference$,
  },
  learning: proactiveLearningSignals,
} as const;

const PREFERENCE_KEYS = {
  jobs: "proactivePlanningAction",
  suggestions: "proactiveSuggestions",
  learning: "proactiveLearning",
} as const;

function ProactivePreference({ kind }: { kind: ProactivePreferenceKind }) {
  const { t } = useTranslation();
  const key = PREFERENCE_KEYS[kind];
  const { preference$, update$ } = PREFERENCE_SIGNALS[kind];
  const preference = useLoadable(preference$);
  const [mutation, update] = useLoadableSet(update$);
  const signal = useGet(pageSignal$);
  const value = preference.state === "hasData" ? preference.data : undefined;
  const failed =
    preference.state === "hasError" || mutation.state === "hasError";
  const busy = preference.state === "loading" || mutation.state === "loading";
  const statusKey = preferenceStatusKey(value, failed);

  return (
    <div
      className="border-t border-t-gray-400 first:border-t-0"
      data-testid={`proactive-${kind}-preference`}
    >
      <PreferenceCardRow
        icon={Sparkles}
        grouped
        iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
        title={t(($) => {
          return $.settings.preferences[key].title;
        })}
        description={t(($) => {
          return $.settings.preferences[key].description;
        })}
        status={
          <div aria-live="polite" className="text-xs text-muted-foreground">
            {statusKey !== null &&
              t(($) => {
                return $.settings.preferences[key][statusKey];
              })}
          </div>
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences[key].title;
            })}
            checked={value?.enabled ?? false}
            disabled={busy || value === undefined}
            onCheckedChange={(enabled) => {
              detach(update(enabled, signal), Reason.DomCallback);
            }}
          />
        </div>
      </PreferenceCardRow>
    </div>
  );
}

export function ProactiveSuggestionsSettings() {
  const flags = useLoadable(featureSwitch$);
  return flags.state === "hasData" &&
    flags.data[FeatureSwitchKey.AgentSuggestion] ? (
    <ProactivePreference kind="suggestions" />
  ) : null;
}

export function ProactivePlanningActionSettings() {
  const flags = useLoadable(featureSwitch$);
  return flags.state === "hasData" &&
    flags.data[FeatureSwitchKey.ProactiveAgent] ? (
    <ProactivePreference kind="jobs" />
  ) : null;
}

export function ProactiveLearningSettings() {
  const flags = useLoadable(featureSwitch$);
  return flags.state === "hasData" &&
    flags.data[FeatureSwitchKey.ProactiveAgent] ? (
    <ProactivePreference kind="learning" />
  ) : null;
}
