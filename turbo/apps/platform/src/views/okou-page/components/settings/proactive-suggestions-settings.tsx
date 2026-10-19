import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { PreferenceCardRow } from "./preference-card-row.tsx";

function ProactiveSuggestionsPreference() {
  const { t } = useTranslation();
  const preference = useLoadable(proactiveSuggestionsPreference$);
  const [mutation, update] = useLoadableSet(
    updateProactiveSuggestionsPreference$,
  );
  const reload = useSet(reloadProactiveSuggestionsPreference$);
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
  const statusKey = failed
    ? "retryMessage"
    : value?.unavailableReason
      ? "missingDefaultAgent"
      : value?.status === "preparing"
        ? "preparing"
        : value?.status === "error"
          ? "preparationFailed"
          : null;

  return (
    <div
      className="border-t border-t-gray-400"
      data-testid="proactive-suggestions-preference"
    >
      <PreferenceCardRow
        icon={Sparkles}
        grouped
        iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
        title={t(($) => {
          return $.settings.preferences.proactiveSuggestions.title;
        })}
        description={t(($) => {
          return $.settings.preferences.proactiveSuggestions.description;
        })}
        status={
          <div aria-live="polite" className="text-xs text-muted-foreground">
            {statusKey !== null &&
              t(($) => {
                return $.settings.preferences.proactiveSuggestions[statusKey];
              })}
          </div>
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          {(failed || value?.status === "error") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (value?.status === "error") {
                  detach(update(value.enabled, signal), Reason.DomCallback);
                } else {
                  reload();
                }
              }}
            >
              {t(($) => {
                return $.settings.preferences.proactiveSuggestions.retry;
              })}
            </Button>
          )}
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences.proactiveSuggestions.title;
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
    <ProactiveSuggestionsPreference />
  ) : null;
}
