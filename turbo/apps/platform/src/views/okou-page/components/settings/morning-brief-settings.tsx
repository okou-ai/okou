import type { MorningBriefPreferenceResponse } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Loader2, RotateCcw, Sunrise } from "lucide-react";
import { useTranslation } from "react-i18next";

import { currentLocale } from "../../../../i18n/index.ts";
import { emailSubscription$ } from "../../../../signals/okou-page/settings/email-subscription.ts";
import {
  morningBriefPreference$,
  morningBriefPreferenceCardRef$,
  retryMorningBriefPreference$,
  updateMorningBriefPreference$,
  type MorningBriefPreferenceState,
} from "../../../../signals/okou-page/settings/morning-brief-preference.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function nextBriefText(
  state: MorningBriefPreferenceState,
  format: (date: string, timezone: string) => string,
): string | null {
  if (
    state.kind !== "ready" ||
    !state.preference.enabled ||
    !state.preference.nextRunAt ||
    !state.preference.timezone
  ) {
    return null;
  }
  return format(state.preference.nextRunAt, state.preference.timezone);
}

function useEnrollmentStatus(
  state: MorningBriefPreferenceState | undefined,
  nextBrief: string | null,
) {
  const { t } = useTranslation();
  let status = nextBrief;
  if (state?.kind === "ready" && state.preference.status === "preparing") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.preparing;
    });
  }
  if (state?.kind === "ready" && state.preference.status === "error") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.preparationFailed;
    });
  }
  return status;
}

function MorningBriefStatus({
  state,
  loading,
  loadFailed,
  mutationFailed,
}: {
  readonly state: MorningBriefPreferenceState | undefined;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly mutationFailed: boolean;
}) {
  const { t } = useTranslation();
  const unavailable =
    state?.kind === "ready" ? state.preference.unavailableReason : null;
  const conflicted = state?.kind === "error";
  const nextBrief = state
    ? nextBriefText(state, (date, timezone) => {
        const formatted = new Intl.DateTimeFormat(currentLocale(), {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: timezone,
        }).format(new Date(date));
        return t(
          ($) => {
            return $.settings.preferences.morningBrief.nextBrief;
          },
          { date: formatted, timezone },
        );
      })
    : null;

  let status = useEnrollmentStatus(state, nextBrief);
  if (loading) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.loading;
    });
  } else if (loadFailed || mutationFailed) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.retryMessage;
    });
  } else if (state?.kind === "error") {
    status =
      state.code === "MORNING_BRIEF_MULTIPLE_INSTALLATIONS"
        ? t(($) => {
            return $.settings.preferences.morningBrief.multipleInstallations;
          })
        : t(($) => {
            return $.settings.preferences.morningBrief.conflict;
          });
  } else if (unavailable === "missing-timezone") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.missingTimezone;
    });
  } else if (unavailable === "missing-default-agent") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.missingDefaultAgent;
    });
  }

  if (!status) {
    return null;
  }
  const showAlert =
    loadFailed || mutationFailed || conflicted || unavailable !== null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {showAlert && <AlertCircle className="size-3.5 shrink-0" />}
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      <span>{status}</span>
    </div>
  );
}

function MorningBriefDeliveryStatus({
  preference,
}: {
  readonly preference: MorningBriefPreferenceResponse | undefined;
}) {
  const { t } = useTranslation();
  const subscription = useLoadable(emailSubscription$);
  if (
    !preference ||
    preference.unavailableReason !== null ||
    preference.status === "preparing" ||
    preference.status === "error"
  ) {
    return null;
  }
  if (!preference.enabled) {
    return (
      <span>
        {t(($) => {
          return $.settings.preferences.morningBrief.paused;
        })}
      </span>
    );
  }
  if (subscription.state !== "hasData") {
    return (
      <span>
        {t(($) => {
          return $.settings.preferences.morningBrief.checkEmailSubscription;
        })}
      </span>
    );
  }
  const receivesEmail =
    subscription.data.subscribed &&
    subscription.data.deliveryStatus === "available";
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">
        {receivesEmail
          ? t(($) => {
              return $.settings.preferences.morningBrief.chatAndEmail;
            })
          : t(($) => {
              return $.settings.preferences.morningBrief.chatOnly;
            })}
      </span>
      <span>
        {receivesEmail
          ? t(($) => {
              return $.settings.preferences.morningBrief.emailWhenReady;
            })
          : t(($) => {
              return $.settings.preferences.morningBrief.emailOff;
            })}
      </span>
    </div>
  );
}

/**
 * Enabling while a reason is reported returns the unchanged preference, so the
 * switch would silently spring back. The reason copy explains what to fix.
 */
function isToggleDisabled(
  preference: MorningBriefPreferenceResponse | undefined,
  busy: boolean,
): boolean {
  return (
    busy || preference === undefined || preference.unavailableReason !== null
  );
}

export function MorningBriefSettings() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(morningBriefPreference$);
  const [mutationLoadable, updatePreference] = useLoadableSet(
    updateMorningBriefPreference$,
  );
  const retryPreference = useSet(retryMorningBriefPreference$);
  const cardRef = useSet(morningBriefPreferenceCardRef$);
  const pageSignal = useGet(pageSignal$);
  const state =
    preferenceLoadable.state === "hasData"
      ? preferenceLoadable.data
      : undefined;
  const preference = state?.kind === "ready" ? state.preference : undefined;
  const loading = preferenceLoadable.state === "loading";
  const mutating = mutationLoadable.state === "loading";
  const loadFailed = preferenceLoadable.state === "hasError";
  const mutationFailed = mutationLoadable.state === "hasError";
  const conflicted = state?.kind === "error";
  const enabled = preference?.enabled ?? false;

  const handleToggle = (checked: boolean) => {
    detach(updatePreference(checked, pageSignal), Reason.DomCallback);
  };

  const handleRetry = () => {
    if (preference?.status === "error") {
      detach(updatePreference(true, pageSignal), Reason.DomCallback);
      return;
    }
    if (mutationFailed && preference) {
      detach(
        updatePreference(!preference.enabled, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    retryPreference();
  };

  const showRetry =
    loadFailed ||
    mutationFailed ||
    conflicted ||
    preference?.status === "error";

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-testid="morning-brief-preference"
      className="flex flex-col gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PreferenceCardRow
        icon={Sunrise}
        title={t(($) => {
          return $.settings.preferences.morningBrief.title;
        })}
        description={t(($) => {
          return $.settings.preferences.morningBrief.description;
        })}
        status={
          <div
            className="flex flex-col gap-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <MorningBriefStatus
              state={state}
              loading={loading || mutating}
              loadFailed={loadFailed}
              mutationFailed={mutationFailed}
            />
            <MorningBriefDeliveryStatus preference={preference} />
          </div>
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          {showRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              disabled={loading || mutating}
            >
              <RotateCcw />
              {t(($) => {
                return $.settings.preferences.morningBrief.retry;
              })}
            </Button>
          )}
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences.morningBrief.title;
            })}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={isToggleDisabled(
              preference,
              loading || mutating || loadFailed || conflicted,
            )}
          />
        </div>
      </PreferenceCardRow>
    </div>
  );
}
