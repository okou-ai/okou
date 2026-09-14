import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PreferenceCardRow({
  icon: Icon,
  title,
  description,
  status,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly status?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 bg-card p-4 rounded-xl border border-surface-border sm:flex-row sm:items-center sm:gap-4">
      <div className="flex flex-1 items-center gap-4 min-w-0">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <Icon size={22} className="text-muted-foreground" />
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
