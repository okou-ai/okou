import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { CircleCheck, EllipsisVertical, Mail } from "lucide-react";
import { Badge, Button, surfaceVariants } from "@okouai/ui";
import {
  Popover,
  PopoverContent,
  PopoverClose,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import {
  disconnectEmail$,
  emailLinkStatus$,
  setEmailConnectDialogOpen$,
  openEmailManageDialog$,
  emailConnectDialogOpen$,
  emailConnectionTriggerRef$,
} from "../../signals/okou-page/email.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { EmailConnectDialog } from "./email-connect-dialog.tsx";

function EmailDisconnectAction({ email }: { readonly email: string }) {
  const { t } = useTranslation();
  const [operation, disconnect] = useLoadableSet(disconnectEmail$);
  const signal = useGet(pageSignal$);
  return (
    <div>
      <button
        type="button"
        disabled={operation.state === "loading"}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
        onClick={() => {
          detach(disconnect(email, signal), Reason.DomCallback);
        }}
      >
        <span className="shrink-0">
          {t(($) => {
            return operation.state === "loading"
              ? $.connectors.actions.disconnecting
              : $.connectors.actions.disconnect;
          })}
        </span>
      </button>
      {operation.state === "hasError" ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t(($) => {
            return $.works.email.loadError;
          })}
        </p>
      ) : null}
    </div>
  );
}

export function EmailCard() {
  const { t } = useTranslation();
  const status = useLastLoadable(emailLinkStatus$);
  const setConnectOpen = useSet(setEmailConnectDialogOpen$);
  const manage = useSet(openEmailManageDialog$);
  const dialogOpen = useGet(emailConnectDialogOpen$);
  const setTrigger = useSet(emailConnectionTriggerRef$);
  const emails = status.state === "hasData" ? status.data.emails : [];
  const email = emails[0];
  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <Mail
            aria-hidden="true"
            className="h-7 w-7 shrink-0 text-foreground"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="truncate text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.email.title;
              })}
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {t(($) => {
                return $.works.email.description;
              })}
            </div>
          </div>
          {email ? (
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge className="min-w-0 max-w-20 shrink-0 text-xs font-medium text-secondary-foreground sm:max-w-52">
                        <CircleCheck className="shrink-0 text-green-600" />
                        <span className="truncate">{email}</span>
                        {emails.length > 1 ? (
                          <span className="shrink-0">+{emails.length - 1}</span>
                        ) : null}
                      </Badge>
                    }
                  />
                  <TooltipContent>{emails.join(", ")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      ref={setTrigger}
                      showTooltip
                      type="button"
                      variant="quiet"
                      size="icon-xs"
                      className="shrink-0"
                      aria-label={t(($) => {
                        return $.works.email.options;
                      })}
                    >
                      <EllipsisVertical size={16} />
                    </Button>
                  }
                />
                <PopoverContent
                  align="end"
                  className="flex w-40 flex-col gap-0.5 p-2"
                  // Manage hands focus to the dialog, which returns to the card action.
                  finalFocus={dialogOpen ? false : undefined}
                >
                  <PopoverClose
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground"
                    onClick={manage}
                  >
                    {t(($) => {
                      return $.works.email.manage;
                    })}
                  </PopoverClose>
                  {emails.length === 1 ? (
                    <EmailDisconnectAction email={email} />
                  ) : null}
                </PopoverContent>
              </Popover>
            </>
          ) : status.state === "hasData" && status.data.configured ? (
            <Button
              ref={setTrigger}
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 rounded-lg"
              onClick={() => {
                setConnectOpen(true);
              }}
            >
              {t(($) => {
                return $.connectors.actions.connect;
              })}
            </Button>
          ) : (
            <span className="h-8 w-20 shrink-0" aria-hidden="true" />
          )}
        </div>
      </div>
      <EmailConnectDialog />
    </>
  );
}
