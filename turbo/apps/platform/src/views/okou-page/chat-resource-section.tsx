import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../i18n/format.ts";

export const RESOURCE_PREVIEW_LIMIT = 3;

export function ChatResourceSectionHeading({
  title,
  count,
  hasMore = false,
  preview,
  children,
}: {
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
    <div className="group/heading sticky top-0 z-1 mb-0.5 flex min-h-7 items-center gap-2 bg-card px-1">
      <h3 className="text-xs leading-4.5 font-medium text-foreground">
        {title}
      </h3>
      {count !== undefined && (count > 1 || hasMore) && (
        <span className="text-xs leading-4.5 tabular-nums text-muted-foreground">
          {formatLocalizedNumber(count)}
          {hasMore ? "+" : ""}
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {children}
        {preview && (
          <Button
            variant="quiet"
            size="xs"
            className="px-1.5 text-xs leading-4.5 font-normal text-muted-foreground hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset focus-visible:ring-offset-0"
            aria-expanded={preview.expanded}
            onClick={preview.onToggle}
          >
            {t(($) => {
              return preview.expanded
                ? $.chat.resources.collapse
                : $.chat.resources.expand;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}
