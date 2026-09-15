import type { CSSProperties, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { RailTravel } from "../../signals/okou-page/composer-task-chips.ts";

/**
 * A row is a rail, not a set of equal pages. Items pack continuously, so the
 * row always reaches the right edge of the column instead of stopping at a
 * fixed count and leaving the rest of the line empty; whatever does not fit is
 * simply further along, and the pagers move the rail by one visible width.
 * Snapping lands the left edge on an item, so paging never strands a half-cut
 * control under the pager that brought you there.
 */
const RAIL = cn(
  "flex min-w-0 snap-x snap-mandatory items-start overflow-x-auto scroll-smooth",
  "motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
);
/**
 * The rail owns each item's frame so that snapping and the entry stagger have
 * exactly one owner; an item only has to size itself.
 */
const RAIL_ITEM_FRAME = "shrink-0 snap-start";
/**
 * Items resolve left to right as the row arrives. The delay is capped so a
 * catalog of eighteen still finishes in about a fifth of a second: past the
 * first few the eye reads the row as one movement, not as a queue.
 */
const RAIL_ITEM_ENTER = "motion-safe:animate-composer-rail-item-in";
const RAIL_ITEM_ENTER_CAP = 7;
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
 * whichever side still has travel. Focus lifts the mask so a keyboard user
 * never lands on a control the fade has dimmed.
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
 * The pager floats over the edge it points at, the way a carousel control does,
 * so it costs the row no width and the faded item behind it reads as the reason
 * the control is there. It needs its own opaque surface to stay legible on top
 * of that item.
 */
const RAIL_PAGER = cn(
  "absolute z-10 size-7 rounded-full border border-border bg-background p-0 shadow-sm",
  "hover:bg-state-hover-overlay",
);
/** A page is one visible width less an item's worth of overlap for context. */
const RAIL_PAGE_OVERLAP = 64;
/** How far the rail can still travel in each direction, right now. */
function measureRail(element: HTMLElement): RailTravel {
  // A scroll position is fractional under zoom, so a whole pixel of slack
  // keeps a rail that is visually at its end from claiming otherwise.
  const remaining =
    element.scrollWidth - element.clientWidth - element.scrollLeft;
  return {
    canScrollBack: element.scrollLeft > 1,
    canScrollForward: remaining > 1,
  };
}

function ComposerRailPager({ side }: { readonly side: "back" | "forward" }) {
  const { t } = useTranslation();
  const Icon = side === "back" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="quiet"
      className={cn(
        RAIL_PAGER,
        side === "back" ? "left-0" : "right-0",
        // Centred on the rail's own content box, which for a cover row is the
        // art plus its caption; the caption is short enough that the control
        // still reads as centred on the picture.
        "top-1/2 -translate-y-1/2",
      )}
      aria-label={t(($) => {
        return side === "back"
          ? $.chat.taskChips.shelf.previousPage
          : $.chat.taskChips.shelf.nextPage;
      })}
      onClick={(event) => {
        const root = event.currentTarget.closest("[data-rail-root]");
        const rail = root?.querySelector<HTMLElement>("[data-rail]");
        if (!rail) {
          return;
        }
        const step = Math.max(rail.clientWidth - RAIL_PAGE_OVERLAP, 1);
        rail.scrollBy({ left: side === "back" ? -step : step });
      }}
    >
      <Icon className="size-4" aria-hidden />
    </Button>
  );
}

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
        data-rail=""
        className={cn(RAIL, gap, fade, RAIL_FADE_OFF)}
        onScroll={(event) => {
          setTravel(rail, measureRail(event.currentTarget));
        }}
        ref={(node) => {
          if (!node) {
            return;
          }
          setTravel(rail, measureRail(node));
          // The row's own width and its items' widths both decide where the
          // rail ends, and neither is known until the browser has laid them
          // out. Watching the rail covers a resized column; watching the
          // children covers a cover that finishes loading.
          const observer = new ResizeObserver(() => {
            setTravel(rail, measureRail(node));
          });
          observer.observe(node);
          for (const child of node.children) {
            observer.observe(child);
          }
          return () => {
            observer.disconnect();
          };
        }}
      >
        {items.map((item, index) => {
          return (
            <div
              key={`rail-item-${String(index)}`}
              className={cn(RAIL_ITEM_FRAME, RAIL_ITEM_ENTER)}
              style={
                {
                  "--rail-enter-index": Math.min(index, RAIL_ITEM_ENTER_CAP),
                } as CSSProperties
              }
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
