import type { MorningBriefPreferenceResponse } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Loader2, RotateCcw, Sunrise } from "lucide-react";
import { useTranslation } from "react-i18next";

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

  let status: string | null = null;
  if (loading) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.loading;
    });
  } else if (loadFailed || mutationFailed) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.retryMessage;
    });
  } else if (state?.kind === "error") {
    status = t(($) => {
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
  } else if (
    state?.kind === "ready" &&
    state.preference.status === "preparing"
  ) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.preparing;
    });
  } else if (state?.kind === "ready" && state.preference.status === "error") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.preparationFailed;
    });
  }

  const showAlert =
    loadFailed || mutationFailed || conflicted || unavailable !== null;
  // The live region stays mounted so a status appearing later is announced.
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {status && showAlert && <AlertCircle className="size-3.5 shrink-0" />}
      {status && loading && <Loader2 className="size-3.5 animate-spin" />}
      {status && <span>{status}</span>}
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
      className="border-t border-t-gray-400 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <PreferenceCardRow
        icon={Sunrise}
        grouped
        iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
        title={t(($) => {
          return $.settings.preferences.morningBrief.title;
        })}
        description={t(($) => {
          return $.settings.preferences.morningBrief.description;
        })}
        status={
          <MorningBriefStatus
            state={state}
            loading={loading || mutating}
            loadFailed={loadFailed}
            mutationFailed={mutationFailed}
          />
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
