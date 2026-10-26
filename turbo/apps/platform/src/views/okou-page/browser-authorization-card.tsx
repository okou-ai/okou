import { Button } from "@okouai/ui/components/ui/button";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Globe, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BrowserAuthorizationSignals } from "../../signals/chat-page/browser-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

export function BrowserAuthorizationCard({
  signals,
}: {
  signals: BrowserAuthorizationSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const request = useLoadable(signals.request$);
  const [operation, allow] = useLoadableSet(signals.allow$);
  const loading = request.state === "loading";
  const data = request.state === "hasData" ? request.data : null;
  const busy = operation.state === "loading";
  const failed = operation.state === "hasError";
  const enabled =
    data !== null && (data.cloudBrowserEnabled || data.completedAt !== null);
  const unavailable = !loading && !data;

  return (
    <ChatCard
      data-testid="browser-authorization-card"
      className="flex h-[224px] w-full flex-col justify-between gap-3 p-3 text-left @[320px]:h-[200px] @[640px]:h-[112px] @[640px]:flex-row @[640px]:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Globe size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.authorization.browser.title;
            })}
          </div>
          <p
            className="mt-0.5 text-sm leading-5 text-muted-foreground"
            aria-live="polite"
          >
            {failed
              ? t(($) => {
                  return $.authorization.browser.actionFailed;
                })
              : unavailable
                ? t(($) => {
                    return $.authorization.browser.unavailableDescription;
                  })
                : enabled
                  ? t(($) => {
                      return $.authorization.browser.enabled;
                    })
                  : t(($) => {
                      return $.authorization.browser.cardDescription;
                    })}
          </p>
        </div>
      </div>
      {!unavailable && (
        <Button
          variant="secondary"
          className="w-full shrink-0 @[640px]:w-auto"
          disabled={loading || enabled || failed}
          pending={busy}
          onClick={() => {
            detach(allow(pageSignal), Reason.DomCallback);
          }}
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : enabled ? (
            <Check />
          ) : null}
          {enabled
            ? t(($) => {
                return $.authorization.browser.allowed;
              })
            : t(($) => {
                return $.authorization.browser.allow;
              })}
        </Button>
      )}
    </ChatCard>
  );
}
