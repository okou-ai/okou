import { surfaceVariants } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  debugLearningAutomation$,
  debugLearningEnabled$,
  learningRunCardRef$,
  runDebugLearning$,
} from "../../../../signals/okou-page/settings/debug-learning.ts";
import { settingsActionSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, isAbortError, Reason } from "../../../../signals/utils.ts";
import { Link } from "../../../router/link.tsx";

export function LearningRunCard() {
  const { t } = useTranslation();
  const enabled = useLoadable(debugLearningEnabled$);
  const automation = useLoadable(debugLearningAutomation$);
  const [starting, run] = useLoadableSet(runDebugLearning$);
  const signal = useGet(settingsActionSignal$);
  const cardRef = useSet(learningRunCardRef$);
  if (enabled.state !== "hasData" || !enabled.data) {
    return null;
  }
  const target = automation.state === "hasData" ? automation.data : null;
  const response = starting.state === "hasData" ? starting.data : null;
  const error = starting.state === "hasError" ? starting.error : undefined;

  return (
    <section
      ref={cardRef}
      aria-labelledby="learning-run-title"
      className={surfaceVariants({
        radius: "compact",
        className: "flex flex-col gap-3 p-4",
      })}
    >
      <div className="flex flex-wrap items-center gap-4">
        <Brain size={22} className="shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3
            id="learning-run-title"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.settings.preferences.debug.learning.title;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.learning.description;
            })}
          </p>
        </div>
        <Button
          type="button"
          disabled={!signal || !target || starting.state !== "idle"}
          onClick={() => {
            if (signal && target) {
              detach(run(target.id, signal), Reason.DomCallback);
            }
          }}
        >
          {starting.state === "loading"
            ? t(($) => {
                return $.settings.preferences.debug.learning.starting;
              })
            : t(($) => {
                return $.settings.preferences.debug.learning.run;
              })}
        </Button>
      </div>
      {automation.state === "hasData" && !target && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.learning.notInstalled;
          })}
        </p>
      )}
      {automation.state === "hasError" && !isAbortError(automation.error) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.learning.unavailable;
          })}
        </p>
      )}
      {response && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.learning.queued;
            })}
          </p>
          <Link
            pathname="/chats/:threadId"
            options={{ pathParams: { threadId: response.chatThreadId } }}
            className="text-sm text-primary hover:underline"
          >
            {t(($) => {
              return $.settings.preferences.debug.learning.openChat;
            })}
          </Link>
        </>
      )}
      {error !== undefined && !isAbortError(error) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.learning.requestFailed;
          })}
        </p>
      )}
    </section>
  );
}
