import type { CSSProperties, ReactNode } from "react";
import { cn } from "@okouai/ui/lib/utils";
import { ComposerRailPager } from "./rail-pager.tsx";
import { COMPOSER_RAIL_FADE, RAIL_ROOT_CLASS } from "./rail-boundary.ts";
import { RailViewport } from "./rail-viewport.tsx";

/**
 * A row is a rail, not a set of equal pages. Items pack continuously, so the
 * row always reaches the right edge of the column instead of stopping at a
 * fixed count and leaving the rest of the line empty; whatever does not fit is
 * simply further along, and the pagers move the rail by one visible width.
 *
 * `scroll-pl-14` is the fade's own width, and the two have to stay equal. Snap
 * alignment honours scroll padding, so every rest position leaves a 56px gutter
 * ahead of the leading item: the fade then dissolves only the tail of the item
 * behind it, never the complete one being read. Without it the leading item
 * lands flush at the edge and the mask eats its first 56px and the start of its
 * caption. The back pager lives in that same gutter, so it stops covering art
 * too.
 */
const RAIL = cn(
  "min-w-0 snap-x snap-mandatory overflow-x-auto scroll-smooth",
  "scroll-pl-14",
  "motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
);
/**
 * The rail owns each item's frame so that snapping and the entry stagger have
 * exactly one owner; an item fills its frame rather than sizing the rail.
 */
const RAIL_ITEM_FRAME = "w-(--rail-item-width) shrink-0 snap-start";
/**
 * Items resolve left to right as the row arrives. The step is capped so a
 * catalog of eighteen still finishes in about a fifth of a second: past the
 * first few the eye reads the row as one movement, not as a queue.
 *
 * The delay is set inline rather than through a utility or a theme token. A
 * `animation-delay` utility loses to the shorthand that `animate-*` compiles
 * to, and a `var()` written into the token resolves against `:root`, where the
 * per-item value does not exist - the token would bake in its own fallback.
 */
const RAIL_ITEM_ENTER = "motion-safe:animate-composer-rail-item-in";
const RAIL_ITEM_ENTER_STEP_MS = 28;
const RAIL_ITEM_ENTER_CAP = 7;
function railItemEnterDelay(index: number): string {
  return `${String(Math.min(index, RAIL_ITEM_ENTER_CAP) * RAIL_ITEM_ENTER_STEP_MS)}ms`;
}
/**
 * Every shelf tile across the types: art in its own box, caption underneath and
 * outside it. `quiet` paints a fill on hover, which on a tile this tall draws a
 * grey slab around the artwork and its caption instead of pointing at either;
 * the art carries the hover itself. The radius is the prompt card's
 * `rounded-xl`, so a cover and the idea card beside it share one corner.
 */
export const RAIL_TILE = cn(
  "group/tile block h-auto rounded-xl p-0 text-left font-normal",
  "hover:bg-transparent active:bg-transparent",
);
/** The caption sits under the art and outside it, on every type's shelf. */
export const RAIL_TILE_CAPTION = "mt-2 block truncate text-[12px] leading-4";
interface RailGeometryStyle extends CSSProperties {
  readonly "--rail-item-width": string;
}

/**
 * Fixed frames keep media/label changes from altering the shelf's extent.
 * Only its rendered count or frame width requests a new content measurement;
 * reading the real track avoids accumulating fractional gap rounding error.
 * CSS owns intermediate viewport widths during sidebar transitions, while
 * native scrolling remains the offset owner.
 */
export function ComposerRail({
  rail,
  label,
  itemWidth,
  items,
}: {
  readonly rail: string;
  /** The frame owns width; its tile fills it rather than choosing another one. */
  readonly itemWidth: number;
  /** Set only when the row is the whole group; a shelf labels its wrapper. */
  readonly label?: string;
  /** The row's items, in order; the rail frames and staggers each one. */
  readonly items: readonly ReactNode[];
}) {
  const geometry: RailGeometryStyle = {
    "--rail-item-width": `${String(itemWidth)}px`,
  };
  return (
    <div
      className={RAIL_ROOT_CLASS}
      style={geometry}
      data-rail-root=""
      role="group"
      aria-label={label}
    >
      <RailViewport
        contentRevision={JSON.stringify([items.length, itemWidth])}
        data-rail={rail}
        className={cn(RAIL, COMPOSER_RAIL_FADE)}
      >
        <div data-rail-track="" className="flex w-max items-start gap-3">
          {items.map((item, index) => {
            return (
              <div
                key={`rail-item-${String(index)}`}
                className={cn(RAIL_ITEM_FRAME, RAIL_ITEM_ENTER)}
                style={{ animationDelay: railItemEnterDelay(index) }}
              >
                {item}
              </div>
            );
          })}
        </div>
      </RailViewport>
      <ComposerRailPager side="back" />
      <ComposerRailPager side="forward" />
    </div>
  );
}
