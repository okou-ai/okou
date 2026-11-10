import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useTranslation } from "react-i18next";
import {
  connectVerifiedEmail$,
  emailConnectDialogOpen$,
  emailLinkStatus$,
  setEmailConnectDialogOpen$,
} from "../../signals/okou-page/email.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { QuestFigure, QuestSplitLayout } from "./get-started-quest-shell.tsx";

function EmailAddressRow({ email }: { readonly email: string }) {
  const { t } = useTranslation();
  const [operation, connect] = useLoadableSet(connectVerifiedEmail$);
  const signal = useGet(pageSignal$);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{email}</span>
        <Button
          type="button"
          size="sm"
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(connect(email, signal), Reason.DomCallback);
          }}
        >
          {operation.state === "loading" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      </div>
      {operation.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.works.email.loadError;
          })}
        </p>
      ) : null}
    </div>
  );
}

export function EmailConnectDialog() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const open = useGet(emailConnectDialogOpen$);
  const setOpen = useSet(setEmailConnectDialogOpen$);
  const status = useLastLoadable(emailLinkStatus$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth={680}>
        <QuestSplitLayout
          figure={
            <div className="hidden sm:contents">
              <QuestFigure art="slack" />
            </div>
          }
        >
          <DialogHeader>
            <DialogTitle className="pr-7">
              {t(
                ($) => {
                  return $.works.email.connectTitle;
                },
                { assistantName },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.works.email.connectDescription;
              })}
            </DialogDescription>
          </DialogHeader>
          {status.state === "hasData" && status.data.configured ? (
            <>
              <a
                href={`mailto:${status.data.address}`}
                className="w-fit break-all text-sm text-foreground underline underline-offset-4 hover:text-muted-foreground"
              >
                {status.data.address}
              </a>
              {status.data.availableEmails
                .filter((email) => {
                  return !status.data.emails.includes(email);
                })
                .map((email) => {
                  return <EmailAddressRow key={email} email={email} />;
                })}
              <p className="text-xs text-muted-foreground">
                {t(($) => {
                  return $.works.email.healthNotice;
                })}
              </p>
            </>
          ) : status.state === "hasError" || status.state === "hasData" ? (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return status.state === "hasError"
                  ? $.works.email.loadError
                  : $.works.email.unavailable;
              })}
            </p>
          ) : (
            <div
              className="flex min-h-40 items-center justify-center"
              role="status"
            >
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          )}
        </QuestSplitLayout>
      </DialogContent>
    </Dialog>
  );
}
