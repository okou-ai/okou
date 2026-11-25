import type { ProactivePreference as ProactivePreferenceValue } from "@okouai/api-contracts/contracts/proactive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { myOkouSuggestionsSignals } from "../../../../signals/okou-page/settings/proactive-preferences.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function preferenceStatusKey(
  value: ProactivePreferenceValue | undefined,
  failed: boolean,
) {
  return failed
    ? "errorMessage"
    : value?.unavailableReason === "missing-timezone"
      ? "missingTimezone"
      : value?.status === "preparing"
        ? "preparing"
        : value?.status === "error"
          ? "preparationFailed"
          : null;
}

function MixedSuggestionsChoice({
  descriptionId,
  disabled,
  onChange,
}: {
  readonly descriptionId: string;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const choices = [
    {
      value: "on",
      label: t(($) => {
        return $.myOkou.proactiveSettings.turnOn;
      }),
    },
    {
      value: "off",
      label: t(($) => {
        return $.myOkou.proactiveSettings.turnOff;
      }),
    },
  ];
  return (
    <Select
      items={choices}
      value={null}
      disabled={disabled}
      onValueChange={(value: string | null) => {
        if (value !== null) {
          onChange(value === "on");
        }
      }}
    >
      <SelectTrigger
        variant="neutral"
        aria-describedby={descriptionId}
        aria-label={t(($) => {
          return $.settings.preferences.proactiveSuggestions.title;
        })}
      >
        <SelectValue
          placeholder={t(($) => {
            return $.myOkou.proactiveSettings.choose;
          })}
        />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => {
          return (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function ProactiveSuggestionsSettings() {
  const { t } = useTranslation();
  const descriptionId = "my-okou-suggestions-description";
  const { preference$, update$ } = myOkouSuggestionsSignals;
  const preference = useLastLoadable(preference$);
  const [mutation, update] = useLoadableSet(update$);
  const signal = useGet(pageSignal$);
  const value = preference.state === "hasData" ? preference.data : undefined;
  const failed =
    preference.state === "hasError" || mutation.state === "hasError";
  const busy = preference.state === "loading" || mutation.state === "loading";
  const statusKey = preferenceStatusKey(value, failed);
  const partial = value?.partial;
  const suggestionDescriptions = t(
    ($) => {
      return $.myOkou.proactiveSettings;
    },
    { returnObjects: true },
  );
  const change = (enabled: boolean) => {
    detach(update(enabled, signal), Reason.DomCallback);
  };

  return (
    <div
      className="border-t border-t-gray-400 first:border-t-0"
      data-testid="proactive-suggestions-preference"
    >
      <PreferenceCardRow
        icon={Sparkles}
        grouped
        inline
        iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
        title={t(($) => {
          return $.settings.preferences.proactiveSuggestions.title;
        })}
        descriptionId={descriptionId}
        description={suggestionDescriptions[partial ?? "suggestions"]}
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
          {partial ? (
            <MixedSuggestionsChoice
              descriptionId={descriptionId}
              disabled={busy}
              onChange={change}
            />
          ) : (
            <Switch
              aria-describedby={descriptionId}
              aria-label={t(($) => {
                return $.settings.preferences.proactiveSuggestions.title;
              })}
              checked={value?.enabled ?? false}
              disabled={busy || value === undefined}
              onCheckedChange={change}
            />
          )}
        </div>
      </PreferenceCardRow>
    </div>
  );
}
