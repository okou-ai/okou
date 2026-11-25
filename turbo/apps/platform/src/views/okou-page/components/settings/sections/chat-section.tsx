import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  PRESENTATION_OUTPUT_FORMATS,
  type PresentationOutputFormat,
} from "@okouai/core/presentation-output-format";
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
import { useTranslation } from "react-i18next";

import { cloudBrowserEnabledByDefault$ } from "../../../../../signals/cloud-browser-preference.ts";
import { featureSwitches$ } from "../../../../../signals/external/feature-switch.ts";
import { modelCatalog$ } from "../../../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../../../signals/external/run-models.ts";
import { userModelPreference$ } from "../../../../../signals/external/user-model-preference.ts";
import { resolveModelFirstStoredUserSelection } from "../../../../../signals/okou-page/model-default-selection.ts";
import { presentationOutputFormat$ } from "../../../../../signals/okou-page/presentation-output-format.ts";
import { updateCloudBrowserEnabledByDefault$ } from "../../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import { updateDefaultModelPreference$ } from "../../../../../signals/okou-page/settings/default-model-preference.ts";
import { updatePresentationFormat$ } from "../../../../../signals/okou-page/settings/presentation-format-preference.ts";
import { updateSendMode$ } from "../../../../../signals/okou-page/settings/send-mode-preference.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { LoadingSkeleton } from "../../../../components/loading-skeleton.tsx";
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

function PresentationFormatDescription({
  failed,
  current,
}: {
  readonly failed: boolean;
  /** `undefined` while the saved default is still loading. */
  readonly current: PresentationOutputFormat | null | undefined;
}) {
  const { t } = useTranslation();
  if (failed) {
    return t(($) => {
      return $.settings.preferences.chat.presentationFormat.unavailable;
    });
  }
  if (current === undefined) {
    return (
      <LoadingSkeleton
        variant="text"
        label={t(($) => {
          return $.settings.preferences.chat.presentationFormat.title;
        })}
      />
    );
  }
  if (current === "html") {
    return t(($) => {
      return $.settings.preferences.chat.presentationFormat.htmlDescription;
    });
  }
  if (current === "pptx") {
    return t(($) => {
      return $.settings.preferences.chat.presentationFormat.pptxDescription;
    });
  }
  return t(($) => {
    return $.settings.preferences.chat.presentationFormat.unsetDescription;
  });
}

function PresentationFormatPreference() {
  const { t } = useTranslation();
  const preference = useLoadable(presentationOutputFormat$);
  const current = preference.state === "hasData" ? preference.data : undefined;
  const [save, update] = useLoadableSet(updatePresentationFormat$);
  const signal = useGet(pageSignal$);
  const title = t(($) => {
    return $.settings.preferences.chat.presentationFormat.title;
  });

  return (
    <PreferenceCardRow
      icon={Presentation}
      title={title}
      description={
        <PresentationFormatDescription
          failed={preference.state === "hasError"}
          current={current}
        />
      }
      status={
        save.state === "hasError" && (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.preferences.chat.presentationFormat.saveFailed;
            })}
          </p>
        )
      }
    >
      {/* Two options, so the same pair of toggles as "Send message with". */}
      <div
        role="group"
        aria-label={title}
        className="flex shrink-0 flex-wrap gap-2"
      >
        {PRESENTATION_OUTPUT_FORMATS.map((value) => {
          return (
            <ToggleButton
              key={value}
              type="button"
              selected={current === value}
              disabled={current === undefined || save.state === "loading"}
              onClick={() => {
                if (current === undefined || value === current) {
                  return;
                }
                detach(update(value, signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return value === "html"
                  ? $.chat.composer.presentationFormatSetup.htmlLabel
                  : $.chat.composer.presentationFormatSetup.pptxLabel;
              })}
            </ToggleButton>
          );
        })}
      </div>
    </PreferenceCardRow>
  );
}

export function ChatSection() {
  const switches = useLastResolved(featureSwitches$);
  const showPresentationFormat =
    switches?.[FeatureSwitchKey.PresentationOutputFormat] ?? false;

  return (
    <section className="flex flex-col gap-3">
      <DefaultModelPreference />
      <CloudBrowserDefaultPreference />
      <SendModePreference />
      {showPresentationFormat && <PresentationFormatPreference />}
    </section>
  );
}
