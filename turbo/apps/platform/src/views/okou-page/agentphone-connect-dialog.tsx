/**
 * The AgentPhone connect dialog: the code to text, and the ways to send it.
 *
 * Two places offer the same link — the Works card and the source-first
 * onboarding step — so the code, the QR, the number and the copy affordances
 * live here rather than once per entry point.
 */
import { useGet, useSet } from "ccstate-react";
import type { AgentPhoneLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { Check, Copy, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button, cn } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import {
  agentPhoneConnectDialogOpen$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

const agentPhoneNumberPattern = /^\+1(\d{3})(\d{3})(\d{4})$/u;

/** Vanity spelling of the shared Okou number, and the subscriber digits it
 *  spells on a phone keypad. */
const agentPhoneVanity = "GET-OKOU";
const agentPhoneVanityDigits = "4386568";

/** Render a US/Canada E.164 number as `+1 (NXX) NXX-XXXX`; other formats are
 *  returned unchanged. */
function formatAgentPhoneNumber(raw: string): string {
  const match = agentPhoneNumberPattern.exec(raw);
  if (!match) {
    return raw;
  }
  return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}

/** Render the number with its vanity spelling, but only while the subscriber
 *  digits still dial it; another `AGENTPHONE_PHONE_NUMBER` keeps its digits. */
function spellAgentPhoneNumber(raw: string): string {
  const match = agentPhoneNumberPattern.exec(raw);
  if (!match || `${match[2]}${match[3]}` !== agentPhoneVanityDigits) {
    return formatAgentPhoneNumber(raw);
  }
  return `+1 (${match[1]}) ${agentPhoneVanity}`;
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

export function PhoneNumberCopyButton({
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
      label={spellAgentPhoneNumber(phoneNumber)}
      // The tooltip and accessible name keep the digits the vanity spelling
      // hides, so the dialable number stays reachable without copying it.
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

export function AgentPhoneConnectDialog({
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
