import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_VOICE_INPUT_MODEL,
  VOICE_INPUT_MODELS,
  voiceInputModelIdSchema,
} from "@okouai/api-contracts/contracts/voice-input-models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  updateVoiceInputModelPreference$,
  voiceInputModelPreference$,
} from "../../../../signals/okou-page/settings/voice-input-model-preference.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

const DEFAULT_MODEL_LABEL = VOICE_INPUT_MODELS.find((model) => {
  return model.id === DEFAULT_VOICE_INPUT_MODEL;
})?.label;

export function VoiceInputModelSettings() {
  const { t } = useTranslation();
  const preference = useLastLoadable(voiceInputModelPreference$);
  const [updateLoadable, updateModel] = useLoadableSet(
    updateVoiceInputModelPreference$,
  );
  const pageSignal = useGet(pageSignal$);
  const current = preference.state === "hasData" ? preference.data : null;
  const items = [
    {
      value: "default",
      label: t(
        ($) => {
          return $.settings.preferences.debug.voiceInput.default;
        },
        {
          model: DEFAULT_MODEL_LABEL,
        },
      ),
    },
    ...VOICE_INPUT_MODELS.map((model) => {
      return {
        value: model.id,
        label: model.label,
      };
    }),
  ];
  if (
    current &&
    !items.some((item) => {
      return item.value === current;
    })
  ) {
    items.push({
      value: current,
      label: t(
        ($) => {
          return $.settings.preferences.debug.voiceInput.unavailable;
        },
        {
          model: current,
        },
      ),
    });
  }

  const handleChange = (value: string) => {
    const model =
      value === "default" ? null : voiceInputModelIdSchema.parse(value);
    detach(updateModel(model, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Mic}
      title={t(($) => {
        return $.settings.preferences.debug.voiceInput.title;
      })}
      description={t(
        ($) => {
          return $.settings.preferences.debug.voiceInput.description;
        },
        { model: DEFAULT_MODEL_LABEL },
      )}
    >
      <div className="w-full shrink-0 sm:w-64">
        <Select
          items={items}
          value={current ?? "default"}
          disabled={
            preference.state !== "hasData" || updateLoadable.state === "loading"
          }
          onValueChange={handleChange}
        >
          <SelectTrigger
            variant="neutral"
            aria-label={t(($) => {
              return $.settings.preferences.debug.voiceInput.title;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {items.map((item) => {
              return (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  disabled={
                    item.value !== "default" &&
                    !voiceInputModelIdSchema.safeParse(item.value).success
                  }
                >
                  {item.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </PreferenceCardRow>
  );
}
