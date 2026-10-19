import { Button } from "@okouai/ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../i18n/format.ts";

export const RESOURCE_PREVIEW_LIMIT = 3;

export function ChatResourceSectionHeading({
  title,
  count,
}: {
  readonly title: string;
  readonly count?: number;
}) {
  return (
    <div className="sticky top-0 z-1 mb-0.5 flex min-h-7 items-center gap-2 bg-card px-1">
      <h3 className="text-xs leading-4.5 font-medium text-foreground">
        {title}
      </h3>
      {count !== undefined && count > 1 && (
        <span className="text-xs leading-4.5 tabular-nums text-muted-foreground">
          {formatLocalizedNumber(count)}
        </span>
      )}
    </div>
  );
}

export function ChatResourceSectionToggle({
  expanded,
  onToggle,
  controls,
}: {
  readonly expanded: boolean;
  readonly onToggle: (trigger: HTMLElement) => void;
  readonly controls: string;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="quiet"
      size="xs"
      className="mt-1 gap-1.5 px-1 text-xs leading-4.5 font-normal text-muted-foreground hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset focus-visible:ring-offset-0 [&_svg]:size-3"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={(event) => {
        onToggle(event.currentTarget);
      }}
    >
      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      {t(($) => {
        return expanded ? $.chat.resources.collapse : $.chat.resources.expand;
      })}
    </Button>
  );
}
