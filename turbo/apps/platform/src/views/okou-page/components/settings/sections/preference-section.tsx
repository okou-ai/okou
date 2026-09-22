import { useGet, useSet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor, Palette } from "lucide-react";
import { surfaceVariants, ToggleButton } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import {
  setTheme$,
  themePreference$,
  type ThemePreference,
} from "../../../../../signals/theme.ts";
import { TimezoneSettings } from "../timezone-settings.tsx";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { EmailSubscriptionSettings } from "../email-subscription-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { AccountSection } from "./account-section.tsx";
import { LanguageSettings } from "../language-settings.tsx";
import { ColorThemeSettings } from "../color-theme-settings.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";
import { SendModePreference } from "./chat-section.tsx";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  icon: typeof Sun;
}[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

function AppearanceBlock() {
  const { t } = useTranslation();
  const prefLoadable = useLoadable(themePreference$);
  const current =
    prefLoadable.state === "hasData" ? prefLoadable.data : "system";
  const updateTheme = useSet(setTheme$);

  const handleChange = (value: ThemePreference) => {
    updateTheme(value);
  };

  return (
    <div className="flex flex-col gap-3">
      <PreferenceCardRow
        icon={Palette}
        title={t(($) => {
          return $.settings.preferences.appearance.theme.title;
        })}
        description={t(($) => {
          return $.settings.preferences.appearance.theme.description;
        })}
      >
        <div className="flex flex-wrap gap-2 shrink-0">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => {
            const isActive = current === value;
            const label =
              value === "light"
                ? t(($) => {
                    return $.settings.preferences.appearance.theme.light;
                  })
                : value === "dark"
                  ? t(($) => {
                      return $.settings.preferences.appearance.theme.dark;
                    })
                  : t(($) => {
                      return $.settings.preferences.appearance.theme.system;
                    });
            return (
              <ToggleButton
                key={value}
                type="button"
                selected={isActive}
                onClick={() => {
                  handleChange(value);
                }}
              >
                <Icon size={15} />
                {label}
              </ToggleButton>
            );
          })}
        </div>
      </PreferenceCardRow>
    </div>
  );
}

export function PreferenceSection() {
  const { t } = useTranslation();
  const featureSwitches = useGet(featureSwitch$);
  const chatPreferenceEnabled =
    featureSwitches[FeatureSwitchKey.ChatPreference] ?? false;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.account.sectionTitle;
          })}
        />
        <AccountSection />
      </section>

      {featureSwitches[FeatureSwitchKey.MorningBrief] ? (
        <section
          className="flex flex-col gap-3"
          aria-labelledby="email-subscriptions-heading"
        >
          <div id="email-subscriptions-heading">
            <SettingsSectionHeading
              title={t(($) => {
                return $.settings.preferences.emailSubscription.sectionTitle;
              })}
            />
          </div>
          <div
            className={surfaceVariants({
              className: "divide-y divide-border overflow-hidden",
            })}
          >
            <EmailSubscriptionSettings />
            <MorningBriefSettings />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.appearance.sectionTitle;
          })}
          description={t(($) => {
            return $.settings.preferences.appearance.description;
          })}
        />
        <AppearanceBlock />
        <ColorThemeSettings />
        <LanguageSettings />
      </section>

      {!chatPreferenceEnabled ? (
        <section className="flex flex-col gap-3">
          <SettingsSectionHeading
            title={t(($) => {
              return $.settings.preferences.send.sectionTitle;
            })}
            description={t(($) => {
              return $.settings.preferences.send.description;
            })}
          />
          <SendModePreference />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.timezone.sectionTitle;
          })}
          description={t(($) => {
            return $.settings.preferences.timezone.description;
          })}
        />
        <TimezoneSettings />
      </section>
    </div>
  );
}
