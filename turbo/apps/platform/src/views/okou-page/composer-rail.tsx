import type { ReactNode } from "react";
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
export const RAIL_ITEM = "snap-start";
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
  children,
}: {
  readonly signals: ComposerSignals;
  /** Identifies this row's travel; one row per task per kind. */
  readonly rail: string;
  /** Set only when the row is the whole group; a shelf labels its wrapper. */
  readonly label?: string;
  readonly gap: string;
  readonly children: ReactNode;
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
        {children}
      </div>
      {canBack && <ComposerRailPager side="back" />}
      {canForward && <ComposerRailPager side="forward" />}
    </div>
  );
}
