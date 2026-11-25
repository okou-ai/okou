import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { resolvedAppLocale } from "../../i18n/format.ts";
import type { createPlatformEventEntry } from "../../signals/okou-page/platform-feed-events.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { ForYouCardLayout } from "./for-you-card-heading.tsx";

function formatPauseTime(disabledAt: string, timeZone: string | undefined) {
  return new Date(disabledAt).toLocaleString(resolvedAppLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}

/** Why the automation stopped, and when, as the card's details. */
function AutomationPauseDetails({
  entry,
}: {
  readonly entry: ReturnType<typeof createPlatformEventEntry>;
}) {
  const { t } = useTranslation();
  const preferences = useLastResolved(userPreferences$);
  const { content } = entry.item;
  return (
    <div className="mt-6 space-y-3 rounded-xl border border-border bg-card p-4">
      <p className="text-xs leading-4 font-medium text-muted-foreground">
        {t(($) => {
          return $.feedEvents.automationDisabled.systemSource;
        })}
      </p>
      <p className="text-sm leading-[1.375rem] text-foreground">
        {t(
          ($) => {
            return $.feedEvents.automationDisabled.reason;
          },
          { count: content.consecutiveFailures },
        )}
      </p>
      {content.recoveryScheduled && (
        <p className="text-sm leading-[1.375rem] text-muted-foreground">
          {t(($) => {
            return $.feedEvents.automationDisabled.recoveryScheduled;
          })}
        </p>
      )}
      <time
        dateTime={content.disabledAt}
        className="block text-xs leading-4 text-muted-foreground"
      >
        {t(
          ($) => {
            return $.feedEvents.automationDisabled.disabledAt;
          },
          {
            time: formatPauseTime(content.disabledAt, preferences?.timezone),
          },
        )}
      </time>
    </div>
  );
}

export function PlatformFeedEvent({
  entry,
  active,
}: {
  readonly entry: ReturnType<typeof createPlatformEventEntry>;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [dismissal, dismiss] = useLoadableSet(entry.dismiss$);
  const [activation, enable] = useLoadableSet(entry.enable$);
  const { content } = entry.item;
  const busy = activation.state === "loading" || dismissal.state === "loading";
  return (
    <article
      aria-labelledby={`suggestion-title-${entry.item.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ForYouCardLayout
        id={entry.item.id}
        active={active}
        title={t(($) => {
          return $.feedEvents.automationDisabled.title;
        })}
        description={content.automationDescription ?? undefined}
        source={
          <Link
            pathname={ROUTES.workflowDetailAutomations}
            options={{
              pathParams: { workflowId: content.workflowId },
              searchParams: new URLSearchParams({
                automationId: content.automationId,
                workspaceId: content.workspaceId,
              }),
            }}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block max-w-full truncate rounded-sm text-xs leading-4 font-medium text-muted-foreground underline decoration-transparent underline-offset-3 hover:text-foreground hover:decoration-control-border focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t(($) => {
              return $.feedEvents.automationDisabled.viewAutomation;
            })}
          >
            {content.automationName}
          </Link>
        }
        details={<AutomationPauseDetails entry={entry} />}
        actions={
          !busy &&
          (activation.state === "hasError" ||
            dismissal.state === "hasError") && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.feedEvents.automationDisabled.actionFailed;
              })}
            </p>
          )
        }
        footer={
          <div className="flex flex-wrap items-center gap-2 px-2">
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              pending={activation.state === "loading"}
              onClick={() => {
                detach(enable(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.feedEvents.automationDisabled.enable;
              })}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              pending={dismissal.state === "loading"}
              onClick={() => {
                detach(dismiss(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.chat.agentSuggestions.dismiss;
              })}
            </Button>
          </div>
        }
      />
    </article>
  );
}
