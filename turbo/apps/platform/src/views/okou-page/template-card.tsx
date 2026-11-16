import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  TEMPLATE_TILE_CAPTION,
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_NAME,
  TEMPLATE_TILE_SELECTED,
  TEMPLATE_TILE_SELECTION_FRAME,
} from "./template-tile.ts";

/**
 * The control a template card outside the picker is drawn in: every type's
 * shelf on the home and in the capability tray. The card itself is the
 * picker's -- the media hairline, radius and caption all come from
 * `template-tile.ts` -- without the picker's Use button, because here the whole
 * card is the choice and there is nothing to select first and confirm after.
 *
 * The control carries no fill of its own. `quiet` paints a state layer on
 * hover, which on a card this tall draws a grey slab round the art and its
 * caption instead of pointing at either.
 */
export const TEMPLATE_CARD = cn(
  "group/tile block h-auto w-full rounded-xl p-0 text-left font-normal",
  "hover:bg-transparent active:bg-transparent",
);

/**
 * Under the pointer the cover moves a little closer inside its frame. The
 * frame, its hairline and the caption stay put, so a hover changes one thing
 * and never the card's footprint, and there is no lift or shadow: the picker's
 * cards carry neither. The layer fills the frame, so a cover drawn to the
 * frame's edges and one centred in it both scale from the frame's centre.
 */
const TEMPLATE_CARD_COVER = cn(
  "absolute inset-0 flex items-center justify-center",
  "group-hover/tile:scale-[1.04]",
  "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
);

/** A template card's cover in the picker's frame, then its name under it. */
export function TemplateCardFace({
  title,
  ratio,
  selected,
  className,
  children,
}: {
  readonly title: string;
  /** The frame's aspect ratio utility, such as `aspect-video`. */
  readonly ratio: string;
  /**
   * Set only on a card that stays chosen; it takes the picker's selection
   * frame, whose width is constant so choosing never moves the card.
   */
  readonly selected?: boolean;
  /** The frame's own ground, for a cover that is not a screenshot. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const media = (
    <span className={cn(TEMPLATE_TILE_MEDIA, "block", ratio, className)}>
      <span className={TEMPLATE_CARD_COVER}>{children}</span>
    </span>
  );
  return (
    <>
      {selected === undefined ? (
        media
      ) : (
        <span
          className={cn(
            TEMPLATE_TILE_SELECTION_FRAME,
            "block",
            selected && TEMPLATE_TILE_SELECTED,
          )}
        >
          {media}
        </span>
      )}
      <span className={TEMPLATE_TILE_CAPTION}>
        <span className={TEMPLATE_TILE_NAME}>{title}</span>
      </span>
    </>
  );
}

/** A template card whose whole surface starts the template. */
export function TemplateCard({
  title,
  label,
  description,
  slot,
  ratio,
  coverClassName,
  children,
  onSelect,
}: {
  readonly title: string;
  /** The accessible name, where it says more than the title. */
  readonly label?: string;
  readonly description?: string;
  readonly slot?: string;
  readonly ratio: string;
  readonly coverClassName?: string;
  readonly children: ReactNode;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      data-slot={slot}
      aria-label={label}
      aria-description={description}
      className={TEMPLATE_CARD}
      onClick={onSelect}
    >
      <TemplateCardFace title={title} ratio={ratio} className={coverClassName}>
        {children}
      </TemplateCardFace>
    </Button>
  );
}
