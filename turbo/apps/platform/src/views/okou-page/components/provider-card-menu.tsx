import type { ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import { Button } from "@okouai/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { useTranslation } from "react-i18next";

export function ProviderCardMenu({
  children,
  disabled = false,
  moreOptionsLabel,
  disconnectLabel,
  uninstallLabel,
  onDisconnect,
  onUninstall,
  disconnecting,
}: {
  children?: ReactNode;
  disabled?: boolean;
  moreOptionsLabel: string;
  disconnectLabel: string;
  uninstallLabel?: string;
  onDisconnect?: () => void;
  onUninstall?: () => void;
  disconnecting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-xs"
            className="shrink-0"
            aria-label={moreOptionsLabel}
          >
            <EllipsisVertical size={16} />
          </Button>
        }
      />
      <PopoverContent align="end" className="flex flex-col gap-0.5 w-40 p-2">
        {children}
        {onDisconnect && (
          <button
            type="button"
            aria-label={disconnectLabel}
            disabled={disabled || disconnecting}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
            onClick={onDisconnect}
          >
            {disconnecting
              ? t(($) => {
                  return $.works.actions.disconnecting;
                })
              : t(($) => {
                  return $.works.actions.disconnect;
                })}
          </button>
        )}
        {onUninstall && (
          <button
            type="button"
            aria-label={uninstallLabel}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-state-hover hover:text-accent-foreground transition-colors"
            onClick={onUninstall}
          >
            {t(($) => {
              return $.works.actions.uninstall;
            })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
