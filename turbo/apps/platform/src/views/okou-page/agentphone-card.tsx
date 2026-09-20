import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { AgentPhoneLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import {
  Check,
  CircleCheck,
  Copy,
  EllipsisVertical,
  Loader2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { surfaceVariants, Button, cn } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  agentPhoneLinkStatus$,
  agentPhoneConnectDialogOpen$,
  createAgentPhoneLinkCode$,
  disconnectAgentPhone$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

/** Render a US/Canada E.164 number as `+1 (NXX) NXX-XXXX`; other formats are
 *  returned unchanged. */
function formatAgentPhoneNumber(raw: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/u.exec(raw);
  if (!match) {
    return raw;
  }
  return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}

function CopyTextButton({
  value,
  label,
  ariaLabel,
  successMessage,
  errorMessage,
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly successMessage: string;
  readonly errorMessage: string;
  readonly className?: string;
}) {
  return (
    <IconTooltipButton
      type="button"
      aria-label={ariaLabel}
      className={cn(
        "group inline-flex items-center gap-1 rounded font-medium text-foreground transition-colors hover:text-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      onClick={(event) => {
        const button = event.currentTarget;
        detach(
          (async () => {
            const copySucceeded = await writeToClipboard(value);
            if (copySucceeded) {
              button.dataset.copied = "true";
              toast.success(successMessage);
            } else {
              toast.error(errorMessage);
            }
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {label}
      <Copy
        size={13}
        className="shrink-0 text-muted-foreground group-data-[copied=true]:hidden"
      />
      <Check
        size={13}
        className="hidden shrink-0 text-green-600 group-data-[copied=true]:block"
      />
    </IconTooltipButton>
  );
}

function PhoneNumberCopyButton({
  phoneNumber,
  className,
}: {
  readonly phoneNumber: string;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const formatted = formatAgentPhoneNumber(phoneNumber);

  return (
    <CopyTextButton
      value={phoneNumber}
      label={formatted}
      ariaLabel={t(
        ($) => {
          return $.connectors.providerSettings.agentphone.copyAria;
        },
        { phone: formatted },
      )}
      successMessage={i18n.t(($) => {
        return $.connectors.providerSettings.agentphone.copySuccess;
      })}
      errorMessage={i18n.t(($) => {
        return $.connectors.providerSettings.agentphone.copyError;
      })}
      className={className}
    />
  );
}

function AgentPhoneConnectActions({
  messageHref,
  onClose,
}: {
  readonly messageHref: string | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>
        {t(($) => {
          return $.connectors.actions.close;
        })}
      </Button>
      {messageHref ? (
        <Button asChild>
          <a href={messageHref}>
            {t(($) => {
              return $.connectors.providerSettings.agentphone.openMessages;
            })}
          </a>
        </Button>
      ) : (
        <Button type="button" disabled>
          {t(($) => {
            return $.connectors.providerSettings.agentphone.openMessages;
          })}
        </Button>
      )}
    </DialogFooter>
  );
}

function AgentPhoneConnectIntro() {
  const { t } = useTranslation();
  return (
    <DialogHeader>
      <DialogTitle>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.connectTitle;
        })}
      </DialogTitle>
      <DialogDescription>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.connectDescription;
        })}
      </DialogDescription>
    </DialogHeader>
  );
}

function agentPhoneMessageHref(phoneNumber: string, code: string): string {
  return `sms:${phoneNumber}?body=${encodeURIComponent(code)}`;
}

function AgentPhoneConnectionCodeContent({
  phoneNumber,
  connectionCode,
}: {
  readonly phoneNumber: string;
  readonly connectionCode: AgentPhoneLinkCodeResponse;
}) {
  const { t } = useTranslation();
  const messageHref = agentPhoneMessageHref(phoneNumber, connectionCode.code);

  return (
    <div className="flex flex-col items-center text-center">
      <div className="rounded-xl bg-gray-50 p-3">
        <QRCodeSVG
          value={messageHref}
          size={176}
          level="M"
          marginSize={1}
          bgColor="#ffffff"
          fgColor="#000000"
          title={t(($) => {
            return $.connectors.providerSettings.agentphone.qrTitle;
          })}
          data-testid="agentphone-link-qr"
          data-sms-href={messageHref}
        />
      </div>
      <p className="mt-4 flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-xs text-muted-foreground">
        <span>
          {t(($) => {
            return $.connectors.providerSettings.agentphone.manualSend;
          })}
        </span>
        <CopyTextButton
          value={connectionCode.code}
          label={connectionCode.code}
          ariaLabel={t(
            ($) => {
              return $.connectors.providerSettings.agentphone.copyCodeAria;
            },
            { code: connectionCode.code },
          )}
          successMessage={t(($) => {
            return $.connectors.providerSettings.agentphone.copyCodeSuccess;
          })}
          errorMessage={t(($) => {
            return $.connectors.providerSettings.agentphone.copyCodeError;
          })}
          className="-my-1 rounded-md px-1.5 py-1 font-mono tracking-wide hover:bg-gray-50 hover:text-foreground"
        />
        <span>
          {t(($) => {
            return $.connectors.providerSettings.agentphone.manualSendTo;
          })}
        </span>
        <PhoneNumberCopyButton
          phoneNumber={phoneNumber}
          className="-my-1 rounded-md px-1.5 py-1 hover:bg-gray-50 hover:text-foreground"
        />
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        <time dateTime={connectionCode.expiresAt}>
          {t(($) => {
            return $.connectors.providerSettings.agentphone.codeExpiry;
          })}
        </time>
      </p>
      <p className="mt-5 text-xs text-muted-foreground">
        {t(($) => {
          return $.connectors.providerSettings.agentphone.risk;
        })}
      </p>
    </div>
  );
}

function AgentPhoneConnectionCodeLoading() {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      <span>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.creatingCode;
        })}
      </span>
    </div>
  );
}

function AgentPhoneConnectionCodeError({
  onRetry,
}: {
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
      <p className="max-w-72 text-sm text-muted-foreground" role="alert">
        {t(($) => {
          return $.connectors.providerSettings.agentphone.createCodeError;
        })}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.tryAgain;
        })}
      </Button>
    </div>
  );
}

function AgentPhoneConnectDialog({
  phoneNumber,
  connectionCode,
  connectionCodeFailed,
  onRetry,
}: {
  readonly phoneNumber: string | null;
  readonly connectionCode: AgentPhoneLinkCodeResponse | null;
  readonly connectionCodeFailed: boolean;
  readonly onRetry: () => void;
}) {
  const open = useGet(agentPhoneConnectDialogOpen$);
  const setOpen = useSet(setAgentPhoneConnectDialogOpen$);
  if (!phoneNumber) {
    return null;
  }
  const messageHref = connectionCode
    ? agentPhoneMessageHref(phoneNumber, connectionCode.code)
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <DialogContent>
        <AgentPhoneConnectIntro />
        <div className="grid gap-5">
          {connectionCode ? (
            <AgentPhoneConnectionCodeContent
              phoneNumber={phoneNumber}
              connectionCode={connectionCode}
            />
          ) : connectionCodeFailed ? (
            <AgentPhoneConnectionCodeError onRetry={onRetry} />
          ) : (
            <AgentPhoneConnectionCodeLoading />
          )}
          <AgentPhoneConnectActions
            messageHref={messageHref}
            onClose={() => {
              setOpen(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentPhoneCardActions({
  canConnect,
  onConnect,
}: {
  readonly canConnect: boolean;
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectAgentPhone$,
  );
  const pageSignal = useGet(pageSignal$);
  const disconnecting = disconnectLoadable.state === "loading";
  const isConnected = status?.linked ?? false;
  const connectedPhone = status?.linked ? status.phoneHandle : null;

  return (
    <>
      {isConnected ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="agentphone-connected-indicator"
                className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
              >
                <CircleCheck className="h-3 w-3 text-green-600" />
                <span className="min-w-0 truncate">
                  {connectedPhone ??
                    t(($) => {
                      return $.connectors.providerSettings.works.connected;
                    })}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .authorizedSender;
              })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {status !== null && !isConnected && canConnect ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          aria-label={t(($) => {
            return $.connectors.providerSettings.agentphone.connectAria;
          })}
          onClick={onConnect}
        >
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      ) : null}
      {isConnected ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-xs"
              className="shrink-0"
              aria-label={t(($) => {
                return $.connectors.providerSettings.agentphone.options;
              })}
            >
              <EllipsisVertical size={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            <button
              type="button"
              aria-label={t(($) => {
                return $.connectors.actions.disconnect;
              })}
              disabled={disconnecting}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onClick={() => {
                return detach(disconnect(pageSignal), Reason.DomCallback);
              }}
            >
              {disconnecting
                ? t(($) => {
                    return $.connectors.actions.disconnecting;
                  })
                : t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
            </button>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}

export function AgentPhoneCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const [connectionCodeLoadable, createConnectionCode] = useLoadableSet(
    createAgentPhoneLinkCode$,
  );
  const pageSignal = useGet(pageSignal$);
  const setConnectOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const agentPhoneNumber = status?.agentPhoneNumber ?? null;
  const connectionCode =
    connectionCodeLoadable.state === "hasData"
      ? connectionCodeLoadable.data
      : null;
  const requestConnectionCode = () => {
    detach(createConnectionCode(pageSignal), Reason.DomCallback);
  };

  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={imessageIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium text-foreground">
                {t(($) => {
                  return $.connectors.providerSettings.agentphone.phoneLabel;
                })}
              </div>
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {agentPhoneNumber ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="shrink-0">
                    {t(($) => {
                      return $.connectors.providerSettings.agentphone
                        .destination;
                    })}
                  </span>
                  <PhoneNumberCopyButton phoneNumber={agentPhoneNumber} />
                </span>
              ) : (
                t(($) => {
                  return $.connectors.providerSettings.agentphone.description;
                })
              )}
            </div>
          </div>
          <AgentPhoneCardActions
            canConnect={agentPhoneNumber !== null}
            onConnect={() => {
              requestConnectionCode();
              setConnectOpen(true);
            }}
          />
        </div>
      </div>
      <AgentPhoneConnectDialog
        phoneNumber={agentPhoneNumber}
        connectionCode={connectionCode}
        connectionCodeFailed={connectionCodeLoadable.state === "hasError"}
        onRetry={requestConnectionCode}
      />
    </>
  );
}
