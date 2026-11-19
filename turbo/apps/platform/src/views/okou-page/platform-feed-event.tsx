import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { resolvedAppLocale } from "../../i18n/format.ts";
import type { createPlatformEventEntry } from "../../signals/okou-page/platform-feed-events.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

export function PlatformFeedEvent({
  entry,
  active,
}: {
  readonly entry: ReturnType<typeof createPlatformEventEntry>;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const result = useLoadable(entry.result$);
  const action = useGet(entry.action$);
  const handle = useSet(entry.handle$);
  const pending = result.state === "loading";
  const preferences = useLastResolved(userPreferences$);
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const { content } = entry.item;
  return (
    <>
      <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
        <AlertTriangle aria-hidden className="size-4" />
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
        <p className="break-words text-sm font-medium">
          {content.automationName}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(
            ($) => {
              return $.feedEvents.automationDisabled.reason;
            },
            {
              count: content.consecutiveFailures,
            },
          )}
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
              time: new Date(content.disabledAt).toLocaleString(
                resolvedAppLocale(),
                {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZoneName: "short",
                  ...(preferences ? { timeZone: preferences.timezone } : {}),
                },
              ),
            },
          )}
        </time>
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
          <Button
            variant="neutral"
            pending={pending && action === "enable"}
            disabled={pending}
            onClick={() => {
              return detach(handle("enable", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.feedEvents.automationDisabled.enable;
            })}
          </Button>
          <Button
            variant="quiet"
            pending={pending && action === "dismiss"}
            disabled={pending}
            onClick={() => {
              return detach(handle("dismiss", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.agentSuggestions.dismiss;
            })}
          </Button>
        </div>
        {result.state === "hasError" && (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.global.errors.requestFailed;
            })}
          </p>
        )}
      </div>
    </>
  );
}
