import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { resolvedAppLocale } from "../../i18n/format.ts";
import type { createPlatformEventEntry } from "../../signals/okou-page/platform-feed-events.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

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
  const preferences = useLastResolved(userPreferences$);
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const { content } = entry.item;
  const busy = activation.state === "loading" || dismissal.state === "loading";
  return (
    <>
      <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Info aria-hidden className="size-4" />
        {t(($) => {
          return $.feedEvents.automationDisabled.systemSource;
        })}
      </div>
      <div className="flex flex-1 flex-col gap-4">
        <h2
          ref={active ? focusTitle : undefined}
          tabIndex={-1}
          className="break-words text-xl font-medium leading-tight focus:outline-none"
        >
          {t(($) => {
            return $.feedEvents.automationDisabled.title;
          })}
        </h2>
        <div className="flex flex-col gap-1.5 text-sm leading-relaxed wrap-break-word">
          <p className="font-medium">{content.automationName}</p>
          {content.automationDescription && (
            <p className="whitespace-pre-wrap text-muted-foreground">
              {content.automationDescription}
            </p>
          )}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(
            ($) => {
              return $.feedEvents.automationDisabled.reason;
            },
            {
              count: content.consecutiveFailures,
            },
          )}
          {content.recoveryScheduled && (
            <>
              {" "}
              {t(($) => {
                return $.feedEvents.automationDisabled.recoveryScheduled;
              })}
            </>
          )}{" "}
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
            className="inline-block font-medium text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors hover:decoration-current"
          >
            {t(($) => {
              return $.feedEvents.automationDisabled.viewAutomation;
            })}
          </Link>
        </p>
        <time
          dateTime={content.disabledAt}
          className="text-xs text-muted-foreground"
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
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
          <Button
            variant="default"
            disabled={busy}
            pending={activation.state === "loading"}
            onClick={() => {
              return detach(enable(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.feedEvents.automationDisabled.enable;
            })}
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            pending={dismissal.state === "loading"}
            onClick={() => {
              return detach(dismiss(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.agentSuggestions.dismiss;
            })}
          </Button>
        </div>
        {!busy &&
          (activation.state === "hasError" ||
            dismissal.state === "hasError") && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.feedEvents.automationDisabled.actionFailed;
              })}
            </p>
          )}
      </div>
    </>
  );
}
