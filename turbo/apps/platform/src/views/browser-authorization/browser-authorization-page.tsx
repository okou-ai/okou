import { Check, Loader2, Globe } from "lucide-react";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui/components/ui/button";

import {
  applyBrowserAuthorizationRequest$,
  browserAuthorizationRequest$,
} from "../../signals/browser-authorization/browser-authorization.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { locale$ } from "../../signals/locale.ts";
import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";
import {
  AuthorizationErrorState,
  formatTime,
} from "../components/authorization-error-state.tsx";

export function BrowserAuthorizationPage() {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(browserAuthorizationRequest$);
  const [applyLoadable, applyAuthorization] = useLoadableSet(
    applyBrowserAuthorizationRequest$,
  );
  const request =
    requestLoadable.state === "hasData" ? requestLoadable.data : null;

  if (requestLoadable.state === "loading") {
    return (
      <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-4 pb-safe-offset-8 pl-safe-offset-4">
        <Loader2
          size={22}
          className="my-auto shrink-0 animate-spin text-muted-foreground"
        />
      </div>
    );
  }
  if (requestLoadable.state === "hasError" || !request) {
    return (
      <AuthorizationErrorState
        title={t(($) => {
          return $.authorization.browser.unavailableTitle;
        })}
        description={t(($) => {
          return $.authorization.browser.unavailableDescription;
        })}
      />
    );
  }

  const applying = applyLoadable.state === "loading";
  const enabled =
    applyLoadable.state === "hasData" ||
    request.cloudBrowserEnabled ||
    request.completedAt !== null;

  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-4 pb-safe-offset-8 pl-safe-offset-4">
      <div className="my-auto flex w-[500px] max-w-full shrink-0 flex-col gap-6 rounded-xl border border-border bg-background px-6 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <ProductBrandMarkLink />
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
            <Globe size={22} />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.authorization.browser.title;
              })}
            </h1>
            <p className="mx-auto max-w-md text-sm leading-5 text-muted-foreground">
              {t(($) => {
                return $.authorization.browser.description;
              })}
            </p>
          </div>
        </div>

        <Button
          type="button"
          disabled={applying || enabled}
          onClick={() => {
            detach(applyAuthorization(pageSignal), Reason.DomCallback);
          }}
          className="h-10 w-full"
        >
          {applying ? (
            <Loader2 size={16} className="animate-spin" />
          ) : enabled ? (
            <Check size={16} />
          ) : (
            <Globe size={16} />
          )}
          {enabled
            ? t(($) => {
                return $.authorization.browser.enabled;
              })
            : t(($) => {
                return $.authorization.browser.enable;
              })}
        </Button>

        <div className="border-t border-border pt-5 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.authorization.browser.linkExpires;
            },
            { date: formatTime(request.expiresAt, locale) },
          )}
        </div>
      </div>
    </div>
  );
}
