import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { Clock, Loader2 } from "lucide-react";
import {
  userPreferences$,
  updateUserPreference$,
} from "../../../../signals/okou-page/settings/user-preferences.ts";
import {
  COMMON_TIMEZONES,
  getTimezoneLabel,
} from "../../../../signals/okou-page/cron.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function useTimezoneNames(): Readonly<Record<string, string>> {
  const { t } = useTranslation();
  return {
    "Etc/UTC": t(($) => {
      return $.settings.preferences.timezone.zones.utc;
    }),
    "America/New_York": t(($) => {
      return $.settings.preferences.timezone.zones.eastern;
    }),
    "America/Chicago": t(($) => {
      return $.settings.preferences.timezone.zones.central;
    }),
    "America/Denver": t(($) => {
      return $.settings.preferences.timezone.zones.mountain;
    }),
    "America/Los_Angeles": t(($) => {
      return $.settings.preferences.timezone.zones.losAngeles;
    }),
    "America/Anchorage": t(($) => {
      return $.settings.preferences.timezone.zones.alaska;
    }),
    "Pacific/Honolulu": t(($) => {
      return $.settings.preferences.timezone.zones.hawaii;
    }),
    "America/Toronto": t(($) => {
      return $.settings.preferences.timezone.zones.toronto;
    }),
    "America/Vancouver": t(($) => {
      return $.settings.preferences.timezone.zones.vancouver;
    }),
    "America/Sao_Paulo": t(($) => {
      return $.settings.preferences.timezone.zones.brasilia;
    }),
    "Europe/London": t(($) => {
      return $.settings.preferences.timezone.zones.london;
    }),
    "Europe/Berlin": t(($) => {
      return $.settings.preferences.timezone.zones.berlin;
    }),
    "Europe/Paris": t(($) => {
      return $.settings.preferences.timezone.zones.paris;
    }),
    "Europe/Moscow": t(($) => {
      return $.settings.preferences.timezone.zones.moscow;
    }),
    "Asia/Dubai": t(($) => {
      return $.settings.preferences.timezone.zones.dubai;
    }),
    "Asia/Kolkata": t(($) => {
      return $.settings.preferences.timezone.zones.india;
    }),
    "Asia/Shanghai": t(($) => {
      return $.settings.preferences.timezone.zones.shanghai;
    }),
    "Asia/Tokyo": t(($) => {
      return $.settings.preferences.timezone.zones.tokyo;
    }),
    "Asia/Seoul": t(($) => {
      return $.settings.preferences.timezone.zones.seoul;
    }),
    "Asia/Singapore": t(($) => {
      return $.settings.preferences.timezone.zones.singapore;
    }),
    "Australia/Sydney": t(($) => {
      return $.settings.preferences.timezone.zones.sydney;
    }),
    "Pacific/Auckland": t(($) => {
      return $.settings.preferences.timezone.zones.auckland;
    }),
  };
}

export function TimezoneSettings() {
  const { t } = useTranslation();
  const timezoneNames = useTimezoneNames();
  const preferences = useLastResolved(userPreferences$);
  const [tzLoadable, updatePreference] = useLoadableSet(updateUserPreference$);
  const pageSignal = useGet(pageSignal$);

  const loading = tzLoadable.state === "loading";

  const handleChange = onDomEventFn(async (value: string) => {
    await updatePreference({ timezone: value }, pageSignal);
  });

  if (!preferences) {
    return <Skeleton className="h-[76px] w-full rounded-xl" />;
  }

  const currentTimezone =
    preferences.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOptions = (COMMON_TIMEZONES as readonly string[]).includes(
    currentTimezone,
  )
    ? COMMON_TIMEZONES
    : [currentTimezone, ...COMMON_TIMEZONES];

  return (
    <div data-slot="timezone-setting" className="flex flex-col gap-3">
      <PreferenceCardRow
        icon={Clock}
        title={t(($) => {
          return $.settings.preferences.timezone.rowTitle;
        })}
        description={t(($) => {
          return $.settings.preferences.timezone.rowDescription;
        })}
      >
        <div className="relative w-full shrink-0 sm:w-64">
          <Select
            value={currentTimezone}
            onValueChange={handleChange}
            disabled={loading}
          >
            <SelectTrigger variant="neutral">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((tz) => {
                return (
                  <SelectItem key={tz} value={tz}>
                    {getTimezoneLabel(tz, timezoneNames[tz])}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-end pr-8">
              <Loader2
                size={16}
                className="animate-spin text-muted-foreground"
              />
            </div>
          )}
        </div>
      </PreferenceCardRow>
    </div>
  );
}
