import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";
import { formatCodexResetCreditExpiry } from "../../subscription-usage-format.ts";

export function formatCodexResetCredits(
  value: number | null | undefined,
  expiresAt?: string | null,
): string {
  if (value === null || value === undefined) {
    return i18n.t(($) => {
      return $.settings.models.reset.remainingUnavailable;
    });
  }

  // Nothing is left to expire once the count reaches zero, so the deadline is
  // suppressed there instead of contradicting the count.
  const expiry =
    value > 0 ? formatCodexResetCreditExpiry(expiresAt ?? null) : null;
  if (expiry) {
    return i18n.t(
      ($) => {
        return $.settings.models.reset.remainingWithExpiry;
      },
      {
        count: value,
        value: formatLocalizedNumber(value),
        expiry: expiry.relativeText,
      },
    );
  }

  return i18n.t(
    ($) => {
      return $.settings.models.reset.remaining;
    },
    {
      count: value,
      value: formatLocalizedNumber(value),
    },
  );
}

function formatCodexResetCreditsDisplay(value: number | null): string {
  if (value === null) {
    return i18n.t(($) => {
      return $.settings.models.reset.remainingUnknown;
    });
  }
  return formatCodexResetCredits(value);
}

export function CodexResetCreditsButton({
  className,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  onReset,
}: {
  readonly className?: string;
  readonly resetCredits: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly onReset?: () => void;
}) {
  const label = formatCodexResetCredits(resetCredits);
  const displayLabel = formatCodexResetCreditsDisplay(resetCredits);
  const resetDisabled =
    resetPending || resetCredits === 0 || onReset === undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="xs"
            aria-label={label}
            aria-disabled={resetDisabled || undefined}
            className={cn(
              "h-7 min-w-0 gap-1.5 rounded-md px-1 text-xs tabular-nums",
              className,
              resetDisabled &&
                "cursor-default opacity-50 hover:bg-transparent active:bg-transparent",
            )}
            onClick={() => {
              if (!resetDisabled) {
                onReset?.();
              }
            }}
          >
            <RotateCcw size={14} className="shrink-0" aria-hidden />
            <span className="truncate">{displayLabel}</span>
          </Button>
        }
      />
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="border shadow-md"
        style={{
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
      >
        {formatCodexResetCredits(resetCredits, resetCreditsNextExpiresAt)}
      </TooltipContent>
    </Tooltip>
  );
}

export function CodexResetCreditsMenuItem({
  className,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  onReset,
}: {
  readonly className?: string;
  readonly resetCredits: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly onReset?: () => void;
}) {
  const label = formatCodexResetCredits(resetCredits);
  const displayLabel = formatCodexResetCreditsDisplay(resetCredits);
  const resetDisabled =
    resetPending || resetCredits === 0 || onReset === undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuItem
            aria-label={label}
            aria-disabled={resetDisabled || undefined}
            className={cn(
              "shrink-0 gap-1.5 px-1 text-[10px] leading-4 tabular-nums text-muted-foreground hover:text-foreground data-highlighted:text-foreground [&_svg]:size-3",
              className,
              resetDisabled &&
                "opacity-50 hover:bg-transparent hover:text-muted-foreground data-highlighted:bg-transparent data-highlighted:text-muted-foreground active:bg-transparent",
            )}
            closeOnClick={!resetDisabled}
            onClick={() => {
              if (!resetDisabled) {
                onReset?.();
              }
            }}
          >
            <RotateCcw size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{displayLabel}</span>
          </DropdownMenuItem>
        }
      />
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="border shadow-md"
        style={{
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
      >
        {formatCodexResetCredits(resetCredits, resetCreditsNextExpiresAt)}
      </TooltipContent>
    </Tooltip>
  );
}

export function CodexResetUsageDialog({
  open,
  providerType,
  resetCredits,
  resetting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  providerType: ModelProviderType;
  resetCredits: number | null;
  resetting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const remaining = formatCodexResetCredits(resetCredits);
  const provider = t(($) => {
    return providerType === "codex-oauth-token"
      ? $.settings.accountMenu.subscriptions.providers.codex
      : $.settings.accountMenu.subscriptions.providers.claudeCode;
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!resetting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.settings.models.reset.title;
              },
              {
                provider,
              },
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.settings.models.reset.confirmDescription;
              },
              {
                provider,
                remaining,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={resetting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            type="button"
            disabled={resetting || resetCredits === 0}
            onClick={onConfirm}
          >
            {resetting
              ? t(($) => {
                  return $.settings.models.reset.progress;
                })
              : t(($) => {
                  return $.settings.models.actions.resetUsage;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
