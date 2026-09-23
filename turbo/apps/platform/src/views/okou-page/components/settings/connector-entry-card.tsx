import type { ReactNode } from "react";
import { cn, surfaceVariants } from "@okouai/ui";

export function ConnectorEntryStatus({
  label,
  tone,
  className,
}: {
  readonly label: string;
  readonly tone: "neutral" | "success" | "warning";
  readonly className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          tone === "neutral" && "bg-muted-foreground/50",
          tone === "success" && "bg-emerald-500",
          tone === "warning" && "bg-amber-500",
        )}
      />
      <span
        className={cn(
          "min-w-0 truncate",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
        )}
        title={label}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Shared directory presentation, independent of account or authorization models.
 * This root owns the card's layers: secondary actions and the footer (z-20)
 * stay above the whole-card action (z-10) without competing with page controls.
 */
export function ConnectorEntryCard({
  icon,
  label,
  description,
  showDescription,
  indicator,
  status,
  trailingAction,
  footer,
  action,
  interactive,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly showDescription: boolean;
  readonly indicator?: ReactNode;
  readonly status?: ReactNode;
  readonly trailingAction?: ReactNode;
  readonly footer?: ReactNode;
  readonly action: ReactNode;
  readonly interactive: boolean;
}) {
  return (
    <div
      data-slot="connector-card"
      className={cn(
        surfaceVariants({ interactive }),
        "relative isolate flex flex-col text-left",
        showDescription && "overflow-hidden",
        interactive && "cursor-pointer",
      )}
    >
      {action}
      <div
        className={cn(
          "flex items-center gap-2.5 px-5",
          showDescription ? "pb-1 pt-4" : "h-14",
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {label}
        </span>
        {indicator}
      </div>
      {showDescription ? (
        <div className="px-5 pb-4 pt-1">
          <div
            data-testid="connector-help-text"
            className="line-clamp-2 text-xs text-muted-foreground"
          >
            {description}
          </div>
        </div>
      ) : (
        <div className="flex h-11 items-center gap-2 border-t border-border/50 pl-5 pr-2">
          {status}
          {trailingAction}
        </div>
      )}
      {footer ? (
        <div className="relative z-20 border-t border-border/50 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
