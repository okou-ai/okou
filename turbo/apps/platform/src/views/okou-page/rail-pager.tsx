import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";

import { pageRail } from "../../signals/okou-page/rail-travel.ts";

/**
 * The one control that moves a horizontal row. There is no carousel primitive
 * in `@okouai/ui`, and the two rows that need one -- the composer's shelf and
 * the connector directory's category row -- had drawn their own, which is how
 * one of them ended up a different shape from the other. The button is the same
 * object in both places, so it is written once here; what each row still owns
 * is where it sits and which surface it stands on.
 *
 * It floats over the edge it points at rather than sitting beside the row, so
 * it costs the row no width and the item dissolving behind it reads as the
 * reason the control is there. That also means it needs its own opaque fill to
 * stay legible on top of that item -- `surfaceClassName` names the fill of
 * whatever the row sits on, because a pager in a different tone from its
 * surroundings reads as a hole punched in them rather than a control raised off
 * the row.
 *
 * The row it moves is found by `data-rail` inside the nearest `data-rail-root`,
 * so a rail can be nested inside another one without a pager reaching past its
 * own row.
 */
export function RailPager({
  side,
  label,
  className,
  surfaceClassName,
}: {
  readonly side: "back" | "forward";
  readonly label: string;
  /** Where the control sits against its row's own gutter. */
  readonly className?: string;
  /** The fill of the surface the row sits on. */
  readonly surfaceClassName: string;
}) {
  const Icon = side === "back" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="quiet"
      className={cn(
        "absolute top-1/2 z-10 size-7 -translate-y-1/2 rounded-full p-0",
        "border border-border shadow-sm hover:bg-state-hover-overlay",
        surfaceClassName,
        className,
      )}
      aria-label={label}
      onClick={(event) => {
        const root = event.currentTarget.closest("[data-rail-root]");
        const rail = root?.querySelector<HTMLElement>("[data-rail]");
        if (!rail) {
          return;
        }
        pageRail(rail, side);
      }}
    >
      <Icon className="size-4" aria-hidden />
    </Button>
  );
}

/** The composer's shelf: its rail carries no padding, so the pager sits flush. */
export function ComposerRailPager({
  side,
}: {
  readonly side: "back" | "forward";
}) {
  const { t } = useTranslation();
  return (
    <RailPager
      side={side}
      surfaceClassName="bg-background"
      className={side === "back" ? "left-0" : "right-0"}
      label={t(($) => {
        return side === "back"
          ? $.chat.taskChips.shelf.previousPage
          : $.chat.taskChips.shelf.nextPage;
      })}
    />
  );
}
