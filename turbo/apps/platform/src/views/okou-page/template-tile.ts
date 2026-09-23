/**
 * The template gallery's tile chrome, shared by every picker that shows a wall
 * of covers: presentation, illustration, website and creative video. Keeping
 * the class lists in one module is what stops a new gallery from inventing a
 * parallel card with its own scrim, play affordance and caption placement.
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
 * Selection owns a real border; focus owns the ring. Keep the existing media
 * hairline and clipping box so thumbnails and captions retain their geometry.
 * A border on the frame's non-interactive overlay covers that hairline when
 * selected, without reducing the artwork or adding a second visible boundary.
 * Its emphasis width is constant, including while transparent. The tile wrapper
 * owns the local stacking context; the overlay sits with the existing controls.
 */
export const TEMPLATE_TILE_WRAPPER =
  "group/tile relative isolate cursor-pointer";
export const TEMPLATE_TILE_SELECTION_FRAME =
  "relative rounded-xl after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-xl after:border-(length:--border-width-emphasis) after:border-transparent";
export const TEMPLATE_TILE_SELECTED = "after:border-primary";
// Draw preview focus outside the selection border, triggered only by the real
// preview button. Use buttons keep their own focus ring.
export const TEMPLATE_TILE_PREVIEW_FOCUS =
  "has-[[data-template-preview-id]:focus-visible]:ring-2 has-[[data-template-preview-id]:focus-visible]:ring-ring has-[[data-template-preview-id]:focus-visible]:ring-offset-1 ring-offset-card";
export const TEMPLATE_TILE_MEDIA =
  "relative overflow-hidden rounded-xl border border-border bg-muted";
export const TEMPLATE_TILE_SCRIM =
  "pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100";
export const TEMPLATE_TILE_USE =
  "absolute bottom-2 right-2 z-20 h-[30px] rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-100 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover/tile:opacity-100";
// Caption metrics track the illustration card: same text size, and enough
// breathing room under the artwork that the title never crowds it.
export const TEMPLATE_TILE_CAPTION = "flex items-baseline gap-2 px-2 pb-2 pt-2";
export const TEMPLATE_TILE_NAME =
  "min-w-0 truncate text-sm font-medium leading-5 text-foreground";
