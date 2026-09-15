import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { MessageCircle } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { settingsActionSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { createWelcomeThread$ } from "../../../../signals/okou-page/settings/welcome-thread.ts";
import { detach, isAbortError, Reason } from "../../../../signals/utils.ts";

export function WelcomeThreadCard() {
  const { t } = useTranslation();
  const [result, create] = useLoadableSet(createWelcomeThread$);
  // Dismissal aborts this signal before the closing animation finishes.
  const actionSignal = useGet(settingsActionSignal$);
  const pending = result.state === "loading";
  const error = result.state === "hasError" ? result.error : undefined;

  return (
    <section
      aria-labelledby="welcome-thread-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-4">
        <MessageCircle size={22} className="shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3
            id="welcome-thread-title"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.settings.preferences.debug.welcomeThread.title;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.welcomeThread.description;
            })}
          </p>
        </div>
        <Button
          type="button"
          disabled={pending || !actionSignal}
          onClick={() => {
            if (actionSignal) {
              detach(create(actionSignal), Reason.DomCallback);
            }
          }}
        >
          {pending
            ? t(($) => {
                return $.settings.preferences.debug.welcomeThread.creating;
              })
            : t(($) => {
                return $.settings.preferences.debug.welcomeThread.create;
              })}
        </Button>
      </div>
      {error !== undefined && !isAbortError(error) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.welcomeThread.failed;
          })}
        </p>
      )}
    </section>
  );
}
