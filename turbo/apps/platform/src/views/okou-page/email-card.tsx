import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { CircleCheck, EllipsisVertical, Mail } from "lucide-react";
import { Badge, Button, cn } from "@okouai/ui";
import {
  integrationCardLayout,
  type IntegrationCardLayout,
} from "./components/integration-card-layout.ts";
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
  addEmailConnection$,
  emailLinkStatus$,
  setEmailConnectDialogOpen$,
  emailConnectDialogOpen$,
  emailConnectionTriggerRef$,
} from "../../signals/okou-page/email.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { EmailConnectDialog } from "./email-connect-dialog.tsx";

export function EmailCard({ layout }: { layout: IntegrationCardLayout }) {
  const { t } = useTranslation();
  const classes = integrationCardLayout(layout);
  const status = useLastLoadable(emailLinkStatus$);
  const setConnectOpen = useSet(setEmailConnectDialogOpen$);
  const addEmail = useSet(addEmailConnection$);
  const signal = useGet(pageSignal$);
  const dialogOpen = useGet(emailConnectDialogOpen$);
  const setTrigger = useSet(emailConnectionTriggerRef$);
  const emails = status.state === "hasData" ? status.data.emails : [];
  const email = emails[0];
  return (
    <>
      <div data-slot="integration-card" className={classes.frame}>
        <div className={classes.header}>
          <Mail
            aria-hidden="true"
            className={cn("shrink-0 text-foreground", classes.icon)}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="truncate text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.email.title;
              })}
            </div>
            <div
              className={cn(
                "text-sm text-muted-foreground",
                classes.overflow ?? "truncate",
              )}
            >
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
                    onClick={() => {
                      setConnectOpen(true);
                    }}
                  >
                    {t(($) => {
                      return $.works.email.manage;
                    })}
                  </PopoverClose>
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
                detach(addEmail(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.works.email.addEmail;
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
