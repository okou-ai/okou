import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { measureRail } from "../../signals/okou-page/rail-travel.ts";
import { ComposerRailPager } from "./rail-pager.tsx";

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
  "flex min-w-0 snap-x snap-mandatory items-start overflow-x-auto scroll-smooth",
  "scroll-pl-14",
  "motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
);
/**
 * The rail owns each item's frame so that snapping and the entry stagger have
 * exactly one owner; an item only has to size itself.
 */
const RAIL_ITEM_FRAME = "shrink-0 snap-start";
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
 * the art carries the hover itself.
 */
export const RAIL_TILE = cn(
  "group/tile block h-auto rounded-lg p-0 text-left font-normal",
  "hover:bg-transparent active:bg-transparent",
);
/** The caption sits under the art and outside it, on every type's shelf. */
export const RAIL_TILE_CAPTION = "mt-2 block truncate text-[12px] leading-4";
/**
 * The overrun dissolves instead of being cut through a chip or a cover, on
 * whichever side still has travel: at either end that side has nothing to
 * dissolve, so it carries no fade. The 56px here is the rail's scroll padding;
 * changing one without the other puts the fade back over a complete item.
 * Focus lifts the mask so a keyboard user never lands on a control it dimmed.
 */
const RAIL_FADE = {
  none: "",
  back: cn(
    "[-webkit-mask-image:linear-gradient(to_right,transparent,#000_56px)]",
    "[mask-image:linear-gradient(to_right,transparent,#000_56px)]",
  ),
  forward: cn(
    "[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_56px),transparent)]",
    "[mask-image:linear-gradient(to_right,#000_calc(100%_-_56px),transparent)]",
  ),
  both: cn(
    "[-webkit-mask-image:linear-gradient(to_right,transparent,#000_56px,#000_calc(100%_-_56px),transparent)]",
    "[mask-image:linear-gradient(to_right,transparent,#000_56px,#000_calc(100%_-_56px),transparent)]",
  ),
} as const;
const RAIL_FADE_OFF =
  "focus-within:[-webkit-mask-image:none] focus-within:[mask-image:none]";
/**
 * One row of controls, rendered as a rail. Both pagers only exist while the
 * rail has somewhere to go in that direction, so the row never offers to move
 * past its own ends.
 */
export function ComposerRail({
  signals,
  rail,
  label,
  gap,
  items,
}: {
  readonly signals: ComposerSignals;
  /** Identifies this row's travel; one row per task per kind. */
  readonly rail: string;
  /** Set only when the row is the whole group; a shelf labels its wrapper. */
  readonly label?: string;
  readonly gap: string;
  /** The row's items, in order; the rail frames and staggers each one. */
  readonly items: readonly ReactNode[];
}) {
  const travel = useGet(signals.taskChips.railTravel$)[rail];
  const setTravel = useSet(signals.taskChips.setRailTravel$);
  // A stable ref: the command owns the row's observers and their teardown, so
  // a re-render does not detach and rebuild them.
  const bindRail = useSet(signals.taskChips.bindRail$);
  const canBack = travel?.canScrollBack ?? false;
  const canForward = travel?.canScrollForward ?? false;
  const fade = canBack
    ? canForward
      ? RAIL_FADE.both
      : RAIL_FADE.back
    : canForward
      ? RAIL_FADE.forward
      : RAIL_FADE.none;
  return (
    <div
      className="relative min-w-0"
      data-rail-root=""
      role="group"
      aria-label={label}
    >
      <div
        data-rail={rail}
        ref={bindRail}
        className={cn(RAIL, gap, fade, RAIL_FADE_OFF)}
        onScroll={(event) => {
          setTravel(rail, measureRail(event.currentTarget));
        }}
      >
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
      {canBack && <ComposerRailPager side="back" />}
      {canForward && <ComposerRailPager side="forward" />}
    </div>
  );
}
