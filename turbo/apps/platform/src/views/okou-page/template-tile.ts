/** Shared tile chrome for template recommendations and detail previews. */
// Selection and focus use separate boundaries without changing tile geometry.
export const TEMPLATE_TILE_SELECTION_FRAME =
  "relative rounded-xl after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-xl after:border-(length:--border-width-emphasis) after:border-transparent";
export const TEMPLATE_TILE_SELECTED = "after:border-primary";
export const TEMPLATE_TILE_MEDIA =
  "relative overflow-hidden rounded-xl border border-border bg-muted";
export const TEMPLATE_TILE_CAPTION = "flex items-baseline gap-2 px-2 pb-2 pt-2";
export const TEMPLATE_TILE_NAME =
  "min-w-0 truncate text-sm font-medium leading-5 text-foreground";
