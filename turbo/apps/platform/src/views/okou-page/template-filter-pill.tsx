import { cn, Toggle, ToggleGroup } from "@okouai/ui";
import {
  SCROLLBAR_HIDDEN,
  SCROLL_FADE_X,
  type ScrollFade,
} from "./scroll-fade.ts";
import { COMPOSER_RAIL_FADE } from "./rail-boundary.ts";
import { RailViewport } from "./rail-viewport.tsx";

interface TemplateFilterPill {
  readonly id: string;
  readonly label: string;
}

/**
 * A filter group can wrap or scroll. A paged row keeps its ToggleGroup as a
 * max-content track inside the scrollport, so selection/focus remain owned by
 * Base UI while CSS owns the available viewport width. The caller's padding
 * stays on the group/track, so its measured extent includes the whole gutter.
 */
export function TemplateFilterPillRow({
  pills,
  active,
  label,
  className,
  layout = "wrap",
  fade,
  rail,
  onSelect,
}: {
  readonly pills: readonly TemplateFilterPill[];
  readonly active: string;
  readonly label?: string;
  readonly className?: string;
  readonly layout?: "wrap" | "scroll";
  readonly fade?: ScrollFade;
  /** Names the row for a `RailPager` in the nearest `data-rail-root`. */
  readonly rail?: string;
  readonly onSelect: (id: string) => void;
}) {
  // Only rendered labels/order affect this auto-width track. Active selection
  // changes ink/fill, never font weight or metrics, and is not a revision.
  const group = (
    <ToggleGroup
      value={[active]}
      onValueChange={(value) => {
        onSelect(value[0] ?? active);
      }}
      aria-label={label}
      data-rail-track={rail === undefined ? undefined : ""}
      data-fade={fade === "none" ? undefined : fade}
      className={cn(
        "flex items-center gap-1.5",
        rail !== undefined
          ? "w-max"
          : layout === "wrap"
            ? "flex-wrap"
            : ["overflow-x-auto", SCROLLBAR_HIDDEN, SCROLL_FADE_X],
        className,
      )}
    >
      {pills.map((pill) => {
        return (
          <Toggle key={pill.id} value={pill.id} variant="filter">
            {pill.label}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
  return rail === undefined ? (
    group
  ) : (
    <RailViewport
      contentRevision={JSON.stringify([rail, pills])}
      data-rail={rail}
      className={cn(
        "min-w-0 overflow-x-auto",
        SCROLLBAR_HIDDEN,
        COMPOSER_RAIL_FADE,
      )}
    >
      {group}
    </RailViewport>
  );
}
