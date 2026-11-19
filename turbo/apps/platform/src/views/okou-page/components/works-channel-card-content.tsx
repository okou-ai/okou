import type { ReactNode } from "react";

/** Shared layout only; each channel keeps its own surface and connection flow. */
export function WorksChannelCardContent({
  icon,
  title,
  description,
  actions,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-2 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden">
            {icon}
          </span>
          <div className="min-w-0 break-words text-sm font-medium text-foreground">
            {title}
          </div>
        </div>
        <div className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="flex min-h-11 min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border/50 py-1.5 pl-5 pr-2">
        {actions}
      </div>
    </>
  );
}
