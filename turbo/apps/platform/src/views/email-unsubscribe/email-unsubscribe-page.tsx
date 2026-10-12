import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  confirmEmailUnsubscribe$,
  emailUnsubscribeStatus$,
  emailUnsubscribeToken$,
} from "../../signals/email-unsubscribe/email-unsubscribe-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

export function EmailUnsubscribePage() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const brandName = useGet(brandName$);
  const status = useGet(emailUnsubscribeStatus$);
  const token = useGet(emailUnsubscribeToken$);
  const confirm = useSet(confirmEmailUnsubscribe$);

  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto bg-background pt-safe-offset-8 pr-safe-offset-6 pb-safe-offset-8 pl-safe-offset-6">
      <div className="my-auto flex w-[430px] max-w-full shrink-0 flex-col items-center gap-8 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <ProductBrandMark />
        {status === "done" ? (
          <div className="flex flex-col items-center gap-2.5">
            <Check size={20} className="" />
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.doneTitle;
              })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.lifecycle.emailUnsubscribe.body;
                },
                { brandName },
              )}
            </p>
          </div>
        ) : status === "error" || !token ? (
          <div className="flex flex-col items-center gap-2.5">
            <AlertCircle size={20} className="text-destructive" />
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.errorTitle;
              })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.errorBody;
              })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-2.5">
              <h1 className="text-lg font-medium text-foreground">
                {t(($) => {
                  return $.lifecycle.emailUnsubscribe.confirmTitle;
                })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(
                  ($) => {
                    return $.lifecycle.emailUnsubscribe.body;
                  },
                  { brandName },
                )}
              </p>
            </div>
            <Button
              disabled={status === "submitting"}
              onClick={() => {
                detach(confirm(pageSignal), Reason.DomCallback);
              }}
            >
              {status === "submitting" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : null}
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.action;
              })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
