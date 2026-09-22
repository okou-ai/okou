import { cn } from "@okouai/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PreferenceCardRow({
  icon: Icon,
  title,
  description,
  status,
  grouped = false,
  iconContainerClassName,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly status?: ReactNode;
  readonly grouped?: boolean;
  readonly iconContainerClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 bg-card p-4 sm:flex-row sm:items-center sm:gap-4",
        !grouped && "rounded-xl border border-surface-border",
      )}
    >
      <div className="flex flex-1 items-center gap-4 min-w-0">
        <div className="shrink-0">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center text-muted-foreground",
              iconContainerClassName,
            )}
          >
            <Icon size={22} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
          {status}
        </div>
      </div>
      {children}
    </div>
  );
}
