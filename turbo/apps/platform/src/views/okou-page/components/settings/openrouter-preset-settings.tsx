import {
  ORG_OPENROUTER_PRESETS,
  orgOpenrouterPresetSchema,
} from "@okouai/api-contracts/contracts/org-openrouter-preset";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Bug } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  canManageOpenrouterPreset$,
  orgOpenrouterPreset$,
  updateOrgOpenrouterPreset$,
} from "../../../../signals/okou-page/settings/debug-openrouter-preset.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

const SYSTEM_DEFAULT = "system-default";
const presetItems = ORG_OPENROUTER_PRESETS.map((value) => {
  return { value, label: value };
});

function PresetSelect() {
  const { t } = useTranslation();
  const items = [
    {
      value: SYSTEM_DEFAULT,
      label: t(($) => {
        return $.settings.preferences.debug.openrouterPreset.systemDefault;
      }),
    },
    ...presetItems,
  ];
  const preset = useLoadable(orgOpenrouterPreset$);
  const [save, update] = useLoadableSet(updateOrgOpenrouterPreset$);
  const signal = useGet(pageSignal$);
  const current = preset.state === "hasData" ? preset.data : null;
  const parsed = orgOpenrouterPresetSchema.safeParse(current);
  const selectedValue =
    preset.state === "hasData" && current === null
      ? SYSTEM_DEFAULT
      : parsed.success
        ? parsed.data
        : null;
  const title = t(($) => {
    return $.settings.preferences.debug.openrouterPreset.title;
  });
  const placeholder =
    preset.state === "loading"
      ? t(($) => {
          return $.settings.preferences.debug.openrouterPreset.loading;
        })
      : preset.state === "hasError"
        ? t(($) => {
            return $.settings.preferences.debug.openrouterPreset.unavailable;
          })
        : (current ??
          t(($) => {
            return $.settings.preferences.debug.openrouterPreset.systemDefault;
          }));

  return (
    <PreferenceCardRow
      icon={Bug}
      title={title}
      description={t(($) => {
        return $.settings.preferences.debug.openrouterPreset.description;
      })}
    >
      <div className="w-full shrink-0 sm:w-64">
        <Select
          items={items}
          value={selectedValue}
          disabled={preset.state !== "hasData" || save.state === "loading"}
          onValueChange={(value, details) => {
            if (
              value === null ||
              (value === selectedValue && details.reason === "none")
            ) {
              return;
            }
            const selection =
              value === SYSTEM_DEFAULT
                ? null
                : orgOpenrouterPresetSchema.parse(value);
            detach(update(selection, signal), Reason.DomCallback);
          }}
        >
          <SelectTrigger aria-label={title} variant="neutral">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => {
              return (
                <SelectItem key={item.value} value={item.value}>
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

export function OpenrouterPresetSettings() {
  const allowed = useLoadable(canManageOpenrouterPreset$);
  return allowed.state === "hasData" && allowed.data ? <PresetSelect /> : null;
}
