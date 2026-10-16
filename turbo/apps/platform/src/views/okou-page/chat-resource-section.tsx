import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../i18n/format.ts";

export const RESOURCE_PREVIEW_LIMIT = 3;

export function ChatResourceSectionHeading({
  icon: Icon,
  title,
  count,
  hasMore = false,
  preview,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly count?: number;
  readonly hasMore?: boolean;
  readonly preview?: {
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-1 flex min-h-10 items-center gap-2 bg-card px-2 py-1">
      <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {count !== undefined && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatLocalizedNumber(count)}
          {hasMore ? "+" : ""}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {children}
        {preview && (
          <Button
            variant="quiet"
            size="xs"
            iconSize="sm"
            className="gap-1 px-2 text-xs font-normal text-muted-foreground"
            aria-expanded={preview.expanded}
            onClick={preview.onToggle}
          >
            {t(($) => {
              return preview.expanded
                ? $.chat.resources.collapse
                : $.chat.resources.expand;
            })}
            {preview.expanded ? (
              <ChevronUp aria-hidden />
            ) : (
              <ChevronDown aria-hidden />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
