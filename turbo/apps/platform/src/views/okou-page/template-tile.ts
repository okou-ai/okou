/**
 * The template gallery's tile chrome, shared by every picker that shows a wall
 * of covers: presentation, illustration, website, creative video and intro
 * video. Keeping the class lists in one module is what stops a new gallery from
 * inventing a parallel card — the intro video style card did exactly that and
 * ended up with a permanent scrim, a different play affordance and a caption
 * inside the card.
 */

/**
 * Soft, cool-tinted card shadow for the template picker. It reads as the home
 * chat composer's elevation but is not that value: the blue-grey `220 12% 50%`
 * here is a different tint from `--okou-card-shadow`'s warm `30 6% 45%`, and it
 * carries slightly less alpha. Replaces Tailwind `shadow-sm`, whose hard black
 * tint reads muddy on white.
 *
 * `--okou-card-shadow` is declared at `:root` and would resolve here, so this
 * is a colour decision rather than a constraint. Adopting the token would also
 * pick up its gradient-palette override, which this surface has never had.
 */
export const TEMPLATE_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";

/**
 * Gallery tile. Hover feedback comes from the scrim and the Use pill alone —
 * the card already carries a hairline border, so a hover ring only doubled it.
 * The ring is reserved for the selected state, offset so it is drawn outside
 * the card and keeps a gap from the artwork.
 */
export const TEMPLATE_TILE_WRAPPER = "group/tile relative cursor-pointer";
export const TEMPLATE_TILE_RING =
  "rounded-xl ring-offset-1 ring-offset-card transition-shadow duration-150";
export const TEMPLATE_TILE_RING_SELECTED = "ring-1 ring-primary";
export const TEMPLATE_TILE_MEDIA =
  "relative overflow-hidden border border-border bg-muted";
export const TEMPLATE_TILE_SCRIM =
  "pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 group-hover/tile:opacity-100";
export const TEMPLATE_TILE_USE =
  "absolute bottom-2 right-2 z-20 h-[30px] rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-100 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover/tile:opacity-100";
// Caption metrics track the illustration card: same text size, and enough
// breathing room under the artwork that the title never crowds it.
export const TEMPLATE_TILE_CAPTION = "flex items-baseline gap-2 px-2 pb-2 pt-2";
export const TEMPLATE_TILE_NAME =
  "min-w-0 truncate text-sm font-medium leading-5 text-foreground";

/**
 * Selected badge, drawn over the artwork's top-left corner. Callers own the
 * `Check` glyph so the icon import stays with the component that renders it.
 */
export const TEMPLATE_TILE_SELECTED_BADGE =
  "pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground";
