import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ProactivePreference as ProactivePreferenceValue,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useLastResolved, useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { featureSwitches$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  proactiveLearningSignals,
  myOkouSuggestionsSignals,
  proactiveSuggestionsSignals,
} from "../../../../signals/okou-page/settings/proactive-preferences.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function preferenceStatusKey(
  value: ProactivePreferenceValue | undefined,
  failed: boolean,
) {
  return failed
    ? "errorMessage"
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
  suggestions: proactiveSuggestionsSignals,
  learning: proactiveLearningSignals,
} as const;

const PREFERENCE_KEYS = {
  suggestions: "proactiveSuggestions",
  learning: "proactiveLearning",
} as const;

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

function ProactivePreference({
  kind,
  inMyOkou,
}: {
  readonly kind: ProactiveWorkflowKind;
  readonly inMyOkou: boolean;
}) {
  const { t } = useTranslation();
  const descriptionId = `${inMyOkou ? "my-okou" : "preference"}-${kind}-description`;
  const key = PREFERENCE_KEYS[kind];
  const linked = kind === "suggestions" && inMyOkou;
  const { preference$, update$ } = linked
    ? myOkouSuggestionsSignals
    : PREFERENCE_SIGNALS[kind];
  const preference = useLastLoadable(preference$);
  const [mutation, update] = useLoadableSet(update$);
  const signal = useGet(pageSignal$);
  const value:
    | (ProactivePreferenceValue & {
        partial?: "cardsOnly" | "hourlyOnly" | null;
      })
    | undefined = preference.state === "hasData" ? preference.data : undefined;
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
      data-testid={`proactive-${kind}-preference`}
    >
      <PreferenceCardRow
        icon={Sparkles}
        grouped
        inline={inMyOkou}
        iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
        title={t(($) => {
          return $.settings.preferences[key].title;
        })}
        descriptionId={descriptionId}
        description={
          linked
            ? suggestionDescriptions[partial ?? "suggestions"]
            : t(($) => {
                return $.settings.preferences[key].description;
              })
        }
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
                return $.settings.preferences[key].title;
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

export function ProactiveSuggestionsSettings({
  inMyOkou = false,
}: {
  readonly inMyOkou?: boolean;
}) {
  const flags = useLastResolved(featureSwitches$);
  return flags?.[FeatureSwitchKey.AgentSuggestion] ? (
    <ProactivePreference kind="suggestions" inMyOkou={inMyOkou} />
  ) : null;
}

export function ProactiveLearningSettings({
  inline = false,
}: {
  readonly inline?: boolean;
}) {
  const flags = useLastResolved(featureSwitches$);
  return flags?.[FeatureSwitchKey.ProactiveLearning] ? (
    <ProactivePreference kind="learning" inMyOkou={inline} />
  ) : null;
}
