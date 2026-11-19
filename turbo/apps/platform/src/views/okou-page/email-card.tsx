import { WorksChannelCardContent } from "./components/works-channel-card-content.tsx";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { Settings, Mail, Link2 } from "lucide-react";
import { Button, surfaceVariants } from "@okouai/ui";
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

export function EmailCard() {
  const { t } = useTranslation();
  const status = useLastLoadable(emailLinkStatus$);
  const setConnectOpen = useSet(setEmailConnectDialogOpen$);
  const addEmail = useSet(addEmailConnection$);
  const signal = useGet(pageSignal$);
  const dialogOpen = useGet(emailConnectDialogOpen$);
  const setTrigger = useSet(emailConnectionTriggerRef$);
  const emails = status.state === "hasData" ? status.data.emails : [];
  const email = emails[0];
  const address =
    status.state === "hasData" && status.data.configured
      ? status.data.address
      : null;
  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex min-w-0 flex-col" })}
      >
        <WorksChannelCardContent
          actionsPlacement={email ? "footer" : "header"}
          icon={<Mail aria-hidden="true" className="size-5 text-foreground" />}
          title={t(($) => {
            return $.works.email.title;
          })}
          description={
            <>
              {t(($) => {
                return $.works.email.description;
              })}
              {address ? (
                <a
                  href={`mailto:${address}`}
                  className="block break-all underline underline-offset-4 hover:text-foreground"
                >
                  {address}
                </a>
              ) : null}
            </>
          }
          actions={
            <>
              {email ? (
                <>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="whitespace-normal break-all">
                              {email}
                            </span>
                            {emails.length > 1 ? (
                              <span className="shrink-0">
                                +{emails.length - 1}
                              </span>
                            ) : null}
                          </span>
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
                          <Settings size={16} />
                        </Button>
                      }
                    />
                    <PopoverContent
                      align="end"
                      className="flex w-40 flex-col gap-0.5 p-2"
                      // Manage hands focus to the dialog, which returns to the card action.
                      finalFocus={dialogOpen ? false : undefined}
                    >
                      {address ? (
                        <PopoverClose
                          nativeButton={false}
                          role="link"
                          render={<a href={`mailto:${address}`} />}
                          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground"
                        >
                          <Mail
                            size={16}
                            className="shrink-0"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 break-all">{address}</span>
                        </PopoverClose>
                      ) : null}
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
                  showTooltip
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  className="shrink-0 rounded-md border border-border/60"
                  aria-label={t(($) => {
                    return $.works.actions.connect;
                  })}
                  onClick={() => {
                    detach(addEmail(signal), Reason.DomCallback);
                  }}
                >
                  <Link2 size={16} aria-hidden="true" />
                </Button>
              ) : (
                <span className="size-7 shrink-0" aria-hidden="true" />
              )}
            </>
          }
        />
      </div>
      <EmailConnectDialog />
    </>
  );
}
