import { useGet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Cpu, Globe, Keyboard } from "lucide-react";
import { ToggleButton } from "@okouai/ui";
import { Switch } from "@okouai/ui/components/ui/switch";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { orgModelPolicies$ } from "../../../../../signals/external/org-model-policies.ts";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { userModelPreference$ } from "../../../../../signals/external/user-model-preference.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { cloudBrowserEnabledByDefault$ } from "../../../../../signals/cloud-browser-preference.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { resolveModelFirstStoredUserSelection } from "../../../../../signals/okou-page/model-default-selection.ts";
import { updateDefaultModelPreference$ } from "../../../../../signals/okou-page/settings/default-model-preference.ts";
import { updateCloudBrowserEnabledByDefault$ } from "../../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import { updateSendMode$ } from "../../../../../signals/okou-page/settings/send-mode-preference.ts";
import { ModelProviderPicker } from "../../model-provider-picker.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { PaidToolsSection } from "./paid-tools-section.tsx";

const SEND_OPTIONS: readonly SendMode[] = ["enter", "cmd-enter"];

function DefaultModelPreference() {
  const { t } = useTranslation();
  const userPreference = useLastResolved(userModelPreference$);
  const policies = useLastResolved(orgModelPolicies$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateDefaultModelPreference$,
  );
  const pageSignal = useGet(pageSignal$);
  const current = resolveModelFirstStoredUserSelection({
    userPreference,
    policies,
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
          userPreference === undefined || policies === undefined || mutating
        }
        showInheritOption
      />
    </PreferenceCardRow>
  );
}

function CloudBrowserDefaultPreference() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(cloudBrowserEnabledByDefault$);
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

export function SendModePreference() {
  const { t } = useTranslation();
  const prefsLoadable = useLoadable(sendMode$);
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
              disabled={saving}
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

export function ChatSection() {
  const { t } = useTranslation();
  const features = useGet(featureSwitch$);
  const showChatPreferences =
    features[FeatureSwitchKey.ChatPreference] ?? false;
  const showPaidTools =
    showChatPreferences &&
    (features[FeatureSwitchKey.PaidToolControls] ?? false);

  return (
    <div className="flex flex-col gap-8">
      {showChatPreferences ? (
        <section className="flex flex-col gap-3">
          <DefaultModelPreference />
          <CloudBrowserDefaultPreference />
          <SendModePreference />
        </section>
      ) : null}

      {showPaidTools ? (
        <section className="flex flex-col gap-3">
          <SettingsSectionHeading
            title={t(($) => {
              return $.settings.paidTools.title;
            })}
            description={t(($) => {
              return $.settings.paidTools.description;
            })}
          />
          <PaidToolsSection />
        </section>
      ) : null}
    </div>
  );
}
