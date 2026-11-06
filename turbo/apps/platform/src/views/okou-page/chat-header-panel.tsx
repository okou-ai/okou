import type { ReactNode } from "react";
import { Button, PopoverClose } from "@okouai/ui";
import { X } from "lucide-react";

/**
 * Popover surface shared by the chat header panels (Emails, Artifacts): hung
 * below its own trigger, with one size, a title row and a close button.
 */
export const CHAT_HEADER_PANEL_CLASS =
  "flex max-h-[min(600px,var(--available-height))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden p-0";

export function ChatHeaderPanelHeader({
  icon,
  title,
  count,
  closeLabel,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly closeLabel: string;
  /** Controls below the title row, such as search and filters. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="shrink-0 space-y-3 border-b border-border/60 p-4">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 text-muted-foreground">{icon}</span>
        <h2 className="flex-1 text-sm font-medium">
          {title}
          {count !== undefined && (
            <span className="ml-2 text-xs text-muted-foreground">{count}</span>
          )}
        </h2>
        {/* Closing goes through the popover, so its onOpenChange still owns it. */}
        <PopoverClose
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              aria-label={closeLabel}
            />
          }
        >
          <X size={16} />
        </PopoverClose>
      </div>
      {children}
    </div>
  );
}
