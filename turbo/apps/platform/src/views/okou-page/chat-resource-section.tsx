import { Button } from "@okouai/ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

export const RESOURCE_PREVIEW_LIMIT = 3;

// Sections are separated by space alone. Every row shares one height and puts
// its title after a 20px glyph slot, so titles line up across sections.
export const RESOURCE_SECTION_CLASS = "pt-2";
export const RESOURCE_ROW_CLASS =
  "flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-[13px] leading-5 transition-colors hover:bg-state-hover focus-visible:bg-state-hover";
export const RESOURCE_GLYPH_CLASS =
  "flex size-5 shrink-0 items-center justify-center text-muted-foreground";

export function ChatResourceSectionHeading({
  title,
}: {
  readonly title: string;
}) {
  return (
    <div className="sticky top-0 z-1 flex min-h-6 items-center bg-card px-2">
      <h3 className="text-xs leading-4.5 font-medium text-muted-foreground">
        {title}
      </h3>
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
      className="mt-0.5 gap-1.5 px-2 text-xs leading-4.5 font-normal text-muted-foreground hover:bg-state-hover focus-visible:bg-state-hover focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset focus-visible:ring-offset-0 [&_svg]:size-3"
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
