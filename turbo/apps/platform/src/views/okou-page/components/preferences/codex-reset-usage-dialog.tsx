import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  cn,
} from "@okouai/ui";
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
  descriptionId,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  onReset,
}: {
  readonly className?: string;
  readonly descriptionId: string;
  readonly resetCredits: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly onReset?: () => void;
}) {
  const label = formatCodexResetCredits(resetCredits);
  const displayLabel = formatCodexResetCreditsDisplay(resetCredits);
  const description = formatCodexResetCredits(
    resetCredits,
    resetCreditsNextExpiresAt,
  );
  const showDescription = description !== displayLabel;
  const resetDisabled =
    resetPending || resetCredits === 0 || onReset === undefined;

  return (
    <div className={cn("flex min-w-0 flex-col items-end gap-0.5", className)}>
      <Button
        type="button"
        variant="quiet"
        size="xs"
        aria-label={label}
        aria-describedby={showDescription ? descriptionId : undefined}
        aria-disabled={resetDisabled || undefined}
        className={cn(
          "h-7 min-w-0 gap-1.5 rounded-md px-1 text-xs tabular-nums",
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
      {showDescription && (
        <span
          id={descriptionId}
          className="max-w-52 text-right text-xs text-muted-foreground"
        >
          {description}
        </span>
      )}
    </div>
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
  const descriptionId = "account-menu-codex-reset-credit-description";
  const label = formatCodexResetCredits(resetCredits);
  const displayLabel = formatCodexResetCreditsDisplay(resetCredits);
  const description = formatCodexResetCredits(
    resetCredits,
    resetCreditsNextExpiresAt,
  );
  const showDescription = description !== displayLabel;
  const resetDisabled =
    resetPending || resetCredits === 0 || onReset === undefined;

  return (
    <div className={cn("flex min-w-0 flex-col items-end gap-0.5", className)}>
      <DropdownMenuItem
        aria-label={label}
        aria-describedby={showDescription ? descriptionId : undefined}
        aria-disabled={resetDisabled || undefined}
        className={cn(
          "shrink-0 gap-1.5 px-1 text-xs tabular-nums text-muted-foreground hover:text-foreground data-highlighted:text-foreground",
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
        <RotateCcw size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{displayLabel}</span>
      </DropdownMenuItem>
      {showDescription && (
        <span
          id={descriptionId}
          className="max-w-40 text-right text-xs text-muted-foreground"
        >
          {description}
        </span>
      )}
    </div>
  );
}

export function CodexResetUsageDialog({
  open,
  resetCredits,
  resetting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  resetCredits: number | null;
  resetting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const remaining = formatCodexResetCredits(resetCredits);

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
            {t(($) => {
              return $.settings.models.reset.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.settings.models.reset.confirmDescription;
              },
              {
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
