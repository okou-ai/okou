/**
 * The AgentPhone connect dialog: the code to text, and the ways to send it.
 *
 * Three places offer the same link -- the Integrations card, the source-first
 * onboarding step and the Get started iMessage quest -- so the code, the QR,
 * the number and the copy affordances live here rather than once per entry
 * point. It takes the quest dialogs' two-panel shell, because from Get started
 * it is the quest's own screen, and it states the reward wherever the quest can
 * still be earned.
 */
import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import type { AgentPhoneLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { Check, Copy, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button, cn, buttonVariants } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  agentPhoneConnectDialogOpen$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { imessageQuestReward$ } from "../../signals/okou-page/get-started.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import {
  QuestFigure,
  QuestRewardBadge,
  QuestSplitLayout,
} from "./get-started-quest-shell.tsx";

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

function agentPhoneMessageHref(phoneNumber: string, code: string): string {
  return `sms:${phoneNumber}?body=${encodeURIComponent(code)}`;
}

/** A small muted label over the value it names. */
function ConnectionDetail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The code, and the two ways to send it.
 *
 * Scanning is the way from a computer, so the QR leads and the code and number
 * sit beside it for anyone who would rather type. A phone cannot scan its own
 * screen, so on a narrow or touch viewport the QR gives way to a button that
 * opens Messages with the same prefilled text. Nothing else needs a button:
 * the link completes on the phone, and the dialog's own close is the way out.
 */
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="w-fit shrink-0 rounded-xl bg-gray-50 p-3 max-sm:hidden pointer-coarse:hidden">
          <QRCodeSVG
            value={messageHref}
            size={136}
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
        <div className="hidden max-sm:block pointer-coarse:block">
          <a
            href={messageHref}
            className={buttonVariants({ className: "w-full sm:w-auto" })}
            data-testid="agentphone-open-messages"
          >
            {t(($) => {
              return $.connectors.providerSettings.agentphone.openMessages;
            })}
          </a>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="flex flex-col gap-3">
            <ConnectionDetail
              label={t(($) => {
                return $.connectors.providerSettings.agentphone.codeLabel;
              })}
            >
              <CopyTextButton
                value={connectionCode.code}
                label={connectionCode.code}
                ariaLabel={t(
                  ($) => {
                    return $.connectors.providerSettings.agentphone
                      .copyCodeAria;
                  },
                  { code: connectionCode.code },
                )}
                successMessage={t(($) => {
                  return $.connectors.providerSettings.agentphone
                    .copyCodeSuccess;
                })}
                errorMessage={t(($) => {
                  return $.connectors.providerSettings.agentphone.copyCodeError;
                })}
                className="-mx-1.5 rounded-md px-1.5 py-0.5 font-mono text-sm tracking-wide hover:bg-gray-50 hover:text-foreground"
              />
            </ConnectionDetail>
            <ConnectionDetail
              label={t(($) => {
                return $.connectors.providerSettings.agentphone.sendToLabel;
              })}
            >
              <PhoneNumberCopyButton
                phoneNumber={phoneNumber}
                className="-mx-1.5 rounded-md px-1.5 py-0.5 text-sm hover:bg-gray-50 hover:text-foreground"
              />
            </ConnectionDetail>
          </dl>
          <p className="text-xs text-muted-foreground">
            <time dateTime={connectionCode.expiresAt}>
              {t(($) => {
                return $.connectors.providerSettings.agentphone.codeExpiry;
              })}
            </time>
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
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
      className="flex min-h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
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
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
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
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const open = useGet(agentPhoneConnectDialogOpen$);
  const setOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const rewardLoadable = useLastLoadable(imessageQuestReward$);
  const reward =
    rewardLoadable.state === "hasData" ? rewardLoadable.data : null;
  if (!phoneNumber) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      {/* The quest dialogs' width, so the two panels hold the same shape. */}
      <DialogContent smMaxWidth={680}>
        <QuestSplitLayout
          figure={
            // On a narrow viewport the code needs the full width.
            <div className="hidden sm:contents">
              <QuestFigure art="slack" />
            </div>
          }
        >
          <DialogHeader>
            {/* Clear of the close button, which is absolutely placed. */}
            <DialogTitle className="pr-7">
              {t(
                ($) => {
                  return $.connectors.providerSettings.agentphone.connectTitle;
                },
                { assistantName },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .connectDescription;
              })}
            </DialogDescription>
          </DialogHeader>
          {reward !== null && <QuestRewardBadge amount={reward} />}
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
        </QuestSplitLayout>
      </DialogContent>
    </Dialog>
  );
}
