import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/** Shared layout only; each channel keeps its own surface and connection flow. */
export function WorksChannelCardContent({
  icon,
  title,
  description,
  actions,
  actionsPlacement = "header",
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly actions: ReactNode;
  readonly actionsPlacement?: "header" | "footer";
}) {
  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-2 px-5 pt-4",
          actionsPlacement === "header" ? "pb-4" : "pb-3",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
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
        <div className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
      {actionsPlacement === "footer" ? (
        <div className="flex min-h-11 min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border/50 py-1.5 pl-5 pr-2">
          {actions}
        </div>
      ) : null}
    </>
  );
}
