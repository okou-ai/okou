import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ProactivePreference as ProactivePreferenceValue,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  proactiveSuggestionsPreference$,
  reloadProactiveSuggestionsPreference$,
  updateProactiveSuggestionsPreference$,
} from "../../../../signals/okou-page/settings/proactive-suggestions.ts";
import {
  proactiveActionPreference$,
  reloadProactiveActionPreference$,
  updateProactiveActionPreference$,
} from "../../../../signals/okou-page/settings/proactive-action.ts";
import {
  proactiveJobsPreference$,
  reloadProactiveJobsPreference$,
  updateProactiveJobsPreference$,
} from "../../../../signals/okou-page/settings/proactive-jobs.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function preferenceStatusKey(
  value: ProactivePreferenceValue | undefined,
  failed: boolean,
) {
  return failed
    ? "retryMessage"
    : value?.unavailableReason === "missing-default-agent"
      ? "missingDefaultAgent"
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
    reload$: reloadProactiveJobsPreference$,
  },
  action: {
    preference$: proactiveActionPreference$,
    update$: updateProactiveActionPreference$,
    reload$: reloadProactiveActionPreference$,
  },
  suggestions: {
    preference$: proactiveSuggestionsPreference$,
    update$: updateProactiveSuggestionsPreference$,
    reload$: reloadProactiveSuggestionsPreference$,
  },
} as const;

function ProactivePreference({ kind }: { kind: ProactiveWorkflowKind }) {
  const { t } = useTranslation();
  const key =
    kind === "jobs"
      ? "proactiveJobs"
      : kind === "action"
        ? "proactiveAction"
        : "proactiveSuggestions";
  const { preference$, update$, reload$ } = PREFERENCE_SIGNALS[kind];
  const preference = useLoadable(preference$);
  const [mutation, update] = useLoadableSet(update$);
  const reload = useSet(reload$);
  const signal = useGet(pageSignal$);
  const value =
    mutation.state === "hasData" && mutation.data.status === "error"
      ? mutation.data
      : preference.state === "hasData"
        ? preference.data
        : undefined;
  const failed =
    preference.state === "hasError" || mutation.state === "hasError";
  const busy = preference.state === "loading" || mutation.state === "loading";
  const hasPreferenceError = value?.status === "error";
  const statusKey = preferenceStatusKey(value, failed);

  return (
    <div
      className="border-t border-t-gray-400"
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
            {value?.unavailableReason === "proactive-action-enabled"
              ? t(($) => {
                  return $.settings.preferences.proactiveSuggestions
                    .pausedForAction;
                })
              : statusKey !== null &&
                t(($) => {
                  return $.settings.preferences[key][statusKey];
                })}
          </div>
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          {(failed || (hasPreferenceError && !value.enabled)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (hasPreferenceError) {
                  detach(update(value.enabled, signal), Reason.DomCallback);
                } else {
                  reload();
                }
              }}
            >
              {t(($) => {
                return $.settings.preferences[key].retry;
              })}
            </Button>
          )}
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

export function ProactiveActionSettings() {
  const flags = useLoadable(featureSwitch$);
  if (flags.state === "hasData" && flags.data[FeatureSwitchKey.ProactiveJobs]) {
    return <ProactivePreference kind="jobs" />;
  }
  return flags.state === "hasData" &&
    flags.data[FeatureSwitchKey.ProactiveAction] ? (
    <ProactivePreference kind="action" />
  ) : null;
}
