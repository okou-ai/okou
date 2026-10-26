import { surfaceVariants } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Sunrise } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  debugMorningBriefEnabled$,
  runDebugMorningBrief$,
} from "../../../../signals/okou-page/settings/debug-morning-brief.ts";
import { Link } from "../../../router/link.tsx";
import { settingsActionSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, isAbortError, Reason } from "../../../../signals/utils.ts";

export function MorningBriefRunCard() {
  const { t } = useTranslation();
  const enabled = useLoadable(debugMorningBriefEnabled$);
  const [starting, run] = useLoadableSet(runDebugMorningBrief$);
  const signal = useGet(settingsActionSignal$);
  if (enabled.state !== "hasData" || !enabled.data) {
    return null;
  }
  const response = starting.state === "hasData" ? starting.data : null;
  const pending = starting.state === "loading";
  const error = starting.state === "hasError" ? starting.error : undefined;
  const statuses = {
    queued: t(($) => {
      return $.settings.preferences.debug.morningBrief.status.queued;
    }),
    running: t(($) => {
      return $.settings.preferences.debug.morningBrief.status.running;
    }),
    completed: t(($) => {
      return $.settings.preferences.debug.morningBrief.status.completed;
    }),
    failed: t(($) => {
      return $.settings.preferences.debug.morningBrief.status.failed;
    }),
  };
  const active =
    response?.status === "queued" || response?.status === "running";

  return (
    <section
      aria-labelledby="morning-brief-run-title"
      className={surfaceVariants({
        radius: "compact",
        className: "flex flex-col gap-3 p-4",
      })}
    >
      <div className="flex flex-wrap items-center gap-4">
        <Sunrise size={22} className="shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3
            id="morning-brief-run-title"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.settings.preferences.debug.morningBrief.title;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.morningBrief.description;
            })}
          </p>
        </div>
        <Button
          type="button"
          disabled={
            pending || !signal || active || starting.state === "hasError"
          }
          onClick={() => {
            if (signal) {
              detach(run(signal), Reason.DomCallback);
            }
          }}
        >
          {starting.state === "loading"
            ? t(($) => {
                return $.settings.preferences.debug.morningBrief.starting;
              })
            : response
              ? t(($) => {
                  return $.settings.preferences.debug.morningBrief.runAgain;
                })
              : t(($) => {
                  return $.settings.preferences.debug.morningBrief.run;
                })}
        </Button>
      </div>
      {response && (
        <p role="status" className="text-sm text-muted-foreground">
          {statuses[response.status]}
        </p>
      )}
      {response && (
        <div className="flex items-center gap-4">
          <Link
            pathname="/chats/:threadId"
            options={{ pathParams: { threadId: response.chatThreadId } }}
            className="text-sm text-primary hover:underline"
          >
            {t(($) => {
              return $.settings.preferences.debug.morningBrief.openChat;
            })}
          </Link>
        </div>
      )}
      {error !== undefined && !isAbortError(error) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.morningBrief.requestFailed;
          })}
        </p>
      )}
    </section>
  );
}
