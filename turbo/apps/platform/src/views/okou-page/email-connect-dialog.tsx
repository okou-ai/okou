import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { Button, CopyButton, buttonVariants } from "@okouai/ui";
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
  disconnectEmail$,
  createEmailConnectionCode$,
  emailConnectionDialogMode$,
  emailConnectDialogOpen$,
  emailConnectionFinalFocus$,
  emailLinkStatus$,
  setEmailConnectDialogOpen$,
} from "../../signals/okou-page/email.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { ApiError } from "../../lib/api-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { QuestFigure, QuestSplitLayout } from "./get-started-quest-shell.tsx";

function EmailAddressRow({
  email,
  connected = false,
}: {
  readonly email: string;
  readonly connected?: boolean;
}) {
  const { t } = useTranslation();
  const [operation, connect] = useLoadableSet(
    connected ? disconnectEmail$ : connectVerifiedEmail$,
  );
  const signal = useGet(pageSignal$);
  return (
    <div role="group" aria-label={email} className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{email}</span>
        <Button
          type="button"
          size="sm"
          variant={connected ? "outline" : "default"}
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(connect(email, signal), Reason.DomCallback);
          }}
        >
          {operation.state === "loading" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          {t(($) => {
            return connected
              ? $.connectors.actions.disconnect
              : $.connectors.actions.connect;
          })}
        </Button>
      </div>
      {operation.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return operation.error instanceof ApiError &&
              operation.error.status === 409
              ? $.works.email.connectedElsewhere
              : $.works.email.loadError;
          })}
        </p>
      ) : null}
    </div>
  );
}

export function EmailConnectDialog() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const mode = useGet(emailConnectionDialogMode$);
  const open = useGet(emailConnectDialogOpen$);
  const setOpen = useSet(setEmailConnectDialogOpen$);
  const finalFocus = useSet(emailConnectionFinalFocus$);
  const status = useLastLoadable(emailLinkStatus$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        smMaxWidth={680}
        contentClassName="grid-cols-1"
        finalFocus={finalFocus}
      >
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
                  return mode === "manage"
                    ? $.works.email.manageTitle
                    : $.works.email.connectTitle;
                },
                { assistantName },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return mode === "manage"
                  ? $.works.email.manageDescription
                  : $.works.email.connectDescription;
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
              {mode === "manage"
                ? status.data.emails.map((email) => {
                    return (
                      <EmailAddressRow key={email} email={email} connected />
                    );
                  })
                : null}
              {status.data.availableEmails
                .filter((email) => {
                  return !status.data.emails.includes(email);
                })
                .map((email) => {
                  return <EmailAddressRow key={email} email={email} />;
                })}
              <EmailAddAddressCode address={status.data.address} />
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

function EmailAddAddressCode({ address }: { readonly address: string }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [operation, generate] = useLoadableSet(createEmailConnectionCode$);
  const code = operation.state === "hasData" ? operation.data : null;
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={operation.state === "loading"}
        onClick={() => {
          detach(generate(signal), Reason.DomCallback);
        }}
      >
        {operation.state === "loading" ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : null}
        {t(($) => {
          return code ? $.works.email.newCode : $.works.email.addEmail;
        })}
      </Button>
      {operation.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.works.email.codeError;
          })}
        </p>
      ) : null}
      {code ? (
        <div className="space-y-3 rounded-xl bg-gray-50 p-3">
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.works.email.codeInstructions;
            })}
          </p>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <code className="min-w-0 break-all font-mono text-xs">
              {code.code}
            </code>
            <CopyButton
              text={code.code}
              showTooltip={false}
              aria-label={t(
                ($) => {
                  return $.connectors.providerSettings.agentphone.copyCodeAria;
                },
                { code: code.code },
              )}
            />
          </div>
          <time
            dateTime={code.expiresAt}
            className="block text-xs text-muted-foreground"
          >
            {t(($) => {
              return $.connectors.providerSettings.agentphone.codeExpiry;
            })}
          </time>
          <a
            href={`mailto:${address}?subject=${encodeURIComponent(code.code)}&body=${encodeURIComponent(code.code)}`}
            className={buttonVariants({ size: "sm" })}
          >
            {t(($) => {
              return $.works.email.open;
            })}
          </a>
        </div>
      ) : null}
    </div>
  );
}
