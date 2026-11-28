import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { ToggleButton } from "@okouai/ui";
import { Switch } from "@okouai/ui/components/ui/switch";
import {
  useGet,
  useLastResolved,
  useLastLoadable,
  useLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Cpu, Globe, Keyboard, Presentation } from "lucide-react";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import { useTranslation } from "react-i18next";

import { cloudBrowserEnabledByDefault$ } from "../../../../../signals/cloud-browser-preference.ts";
import { modelCatalog$ } from "../../../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../../../signals/external/run-models.ts";
import { userModelPreference$ } from "../../../../../signals/external/user-model-preference.ts";
import { resolveModelFirstStoredUserSelection } from "../../../../../signals/okou-page/model-default-selection.ts";
import { updateCloudBrowserEnabledByDefault$ } from "../../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import { updateDefaultModelPreference$ } from "../../../../../signals/okou-page/settings/default-model-preference.ts";
import { updateSendMode$ } from "../../../../../signals/okou-page/settings/send-mode-preference.ts";
import {
  presentationFormatPreference$,
  presentationOutputFormatEnabled$,
} from "../../../../../signals/okou-page/presentation-output-format.ts";
import { updatePresentationFormat$ } from "../../../../../signals/okou-page/settings/presentation-format-preference.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { ModelProviderPicker } from "../../model-provider-picker.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";

const SEND_OPTIONS: readonly SendMode[] = ["enter", "cmd-enter"];

function DefaultModelPreference() {
  const { t } = useTranslation();
  const userPreference = useLastResolved(userModelPreference$);
  const models = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateDefaultModelPreference$,
  );
  const pageSignal = useGet(pageSignal$);
  const current = resolveModelFirstStoredUserSelection({
    userPreference,
    models,
    catalog,
  });
  const mutating = updateLoadable.state === "loading";

  const handleChange = (selection: Parameters<typeof updatePreference>[0]) => {
    detach(updatePreference(selection, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Cpu}
      title={t(($) => {
        return $.settings.preferences.chat.defaultModel.title;
      })}
      description={t(($) => {
        return $.settings.preferences.chat.defaultModel.description;
      })}
    >
      <ModelProviderPicker
        value={current}
        onChange={handleChange}
        triggerClassName="h-9 w-full sm:w-[260px]"
        disabled={
          userPreference === undefined ||
          models === undefined ||
          catalog === undefined ||
          mutating
        }
      />
    </PreferenceCardRow>
  );
}

function CloudBrowserDefaultPreference() {
  const { t } = useTranslation();
  const preferenceLoadable = useLastLoadable(cloudBrowserEnabledByDefault$);
  const current =
    preferenceLoadable.state === "hasData" ? preferenceLoadable.data : true;
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateCloudBrowserEnabledByDefault$,
  );
  const pageSignal = useGet(pageSignal$);
  const mutating = updateLoadable.state === "loading";

  const handleToggle = (checked: boolean) => {
    detach(updatePreference(checked, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Globe}
      title={t(($) => {
        return $.settings.preferences.chat.cloudBrowser.title;
      })}
      description={t(($) => {
        return $.settings.preferences.chat.cloudBrowser.description;
      })}
    >
      <Switch
        aria-label={t(($) => {
          return $.settings.preferences.chat.cloudBrowser.title;
        })}
        checked={current}
        onCheckedChange={handleToggle}
        disabled={preferenceLoadable.state !== "hasData" || mutating}
      />
    </PreferenceCardRow>
  );
}

function SendModePreference() {
  const { t } = useTranslation();
  const prefsLoadable = useLastLoadable(sendMode$);
  const current: SendMode =
    prefsLoadable.state === "hasData" ? prefsLoadable.data : "enter";
  const [saveLoadable, saveSendMode] = useLoadableSet(updateSendMode$);
  const saving = saveLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleChange = (value: SendMode) => {
    detach(saveSendMode(value, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Keyboard}
      title={t(($) => {
        return $.settings.preferences.send.title;
      })}
      description={
        current === "enter"
          ? t(($) => {
              return $.settings.preferences.send.enterDescription;
            })
          : t(($) => {
              return $.settings.preferences.send.cmdEnterDescription;
            })
      }
    >
      <div className="flex flex-wrap gap-2 shrink-0">
        {SEND_OPTIONS.map((value) => {
          const isActive = current === value;
          const label =
            value === "enter"
              ? t(($) => {
                  return $.settings.preferences.send.enter;
                })
              : t(($) => {
                  return $.settings.preferences.send.cmdEnter;
                });
          return (
            <ToggleButton
              key={value}
              type="button"
              selected={isActive}
              disabled={saving || prefsLoadable.state !== "hasData"}
              onClick={() => {
                handleChange(value);
              }}
            >
              {label}
            </ToggleButton>
          );
        })}
      </div>
    </PreferenceCardRow>
  );
}

function PresentationFormatPreference() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(presentationFormatPreference$);
  const current =
    preferenceLoadable.state === "hasData"
      ? preferenceLoadable.data
      : undefined;
  const [saveLoadable, saveFormat] = useLoadableSet(updatePresentationFormat$);
  const pageSignal = useGet(pageSignal$);
  const saving = saveLoadable.state === "loading";
  const title = t(($) => {
    return $.settings.preferences.chat.presentationFormat.title;
  });
  const description =
    current === "html"
      ? t(($) => {
          return $.settings.preferences.chat.presentationFormat.htmlDescription;
        })
      : current === "pptx"
        ? t(($) => {
            return $.settings.preferences.chat.presentationFormat
              .pptxDescription;
          })
        : current === null
          ? t(($) => {
              return $.settings.preferences.chat.presentationFormat
                .unsetDescription;
            })
          : t(($) => {
              return $.settings.preferences.chat.presentationFormat.unavailable;
            });

  const handleChange = (format: PresentationOutputFormat) => {
    detach(saveFormat(format, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Presentation}
      title={title}
      description={description}
      descriptionId="presentation-format-description"
      status={
        saveLoadable.state === "hasError" ? (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.preferences.chat.presentationFormat.saveFailed;
            })}
          </p>
        ) : undefined
      }
    >
      <div
        role="group"
        aria-label={title}
        aria-describedby="presentation-format-description"
        className="flex flex-wrap gap-2 shrink-0"
      >
        <ToggleButton
          type="button"
          selected={current === "html"}
          disabled={saving || current === undefined}
          onClick={() => {
            handleChange("html");
          }}
        >
          {t(($) => {
            return $.settings.preferences.chat.presentationFormat.html;
          })}
        </ToggleButton>
        <ToggleButton
          type="button"
          selected={current === "pptx"}
          disabled={saving || current === undefined}
          onClick={() => {
            handleChange("pptx");
          }}
        >
          {t(($) => {
            return $.settings.preferences.chat.presentationFormat.pptx;
          })}
        </ToggleButton>
      </div>
    </PreferenceCardRow>
  );
}

export function ChatSection() {
  const formatEnabled = useLoadable(presentationOutputFormatEnabled$);
  return (
    <section className="flex flex-col gap-3">
      <DefaultModelPreference />
      <CloudBrowserDefaultPreference />
      {formatEnabled.state === "hasData" && formatEnabled.data && (
        <PresentationFormatPreference />
      )}
      <SendModePreference />
    </section>
  );
}
