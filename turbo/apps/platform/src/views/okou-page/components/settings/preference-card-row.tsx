import { cn } from "@okouai/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PreferenceCardRow({
  icon: Icon,
  title,
  description,
  descriptionId,
  status,
  grouped = false,
  inline = false,
  iconContainerClassName,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly descriptionId?: string;
  readonly status?: ReactNode;
  readonly grouped?: boolean;
  readonly inline?: boolean;
  readonly iconContainerClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 bg-card p-4 sm:gap-4",
        inline
          ? "flex-row items-center gap-2 px-3 py-3 sm:px-4"
          : "flex-col sm:flex-row sm:items-center",
        !grouped && "rounded-xl border border-surface-border",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-4",
          inline && "gap-2.5 sm:gap-4",
        )}
      >
        <div className="shrink-0">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center text-muted-foreground",
              iconContainerClassName,
              inline && "size-8 sm:size-10",
            )}
          >
            <Icon size={22} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div
            id={descriptionId}
            className={cn(
              "text-sm text-muted-foreground",
              inline && "max-sm:text-xs",
            )}
          >
            {description}
          </div>
          {status}
        </div>
      </div>
      {children}
    </div>
  );
}
