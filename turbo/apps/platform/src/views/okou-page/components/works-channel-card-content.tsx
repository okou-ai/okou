import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/** Shared layout only; each channel keeps its own surface and connection flow. */
export function WorksChannelCardContent({
  icon,
  title,
  description,
  actions,
  actionsPlacement = "header",
  showDescription = actionsPlacement === "header",
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly actions: ReactNode;
  readonly actionsPlacement?: "header" | "footer";
  readonly showDescription?: boolean;
}) {
  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col px-5",
          showDescription ? "gap-2 pb-4 pt-4" : "min-h-14 py-3",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2",
            !showDescription && "min-h-8",
          )}
        >
          <div className="flex min-w-0 flex-auto items-center gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden">
              {icon}
            </span>
            <div className="min-w-0 break-words text-sm font-medium text-foreground">
              {title}
            </div>
          </div>
          {actionsPlacement === "header" ? (
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5 empty:hidden">
              {actions}
            </div>
          ) : null}
        </div>
        {showDescription ? (
          <div className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {actionsPlacement === "footer" ? (
        <div className="flex min-h-11 min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border/50 py-1.5 pl-5 pr-2">
          {actions}
        </div>
      ) : null}
    </>
  );
}
