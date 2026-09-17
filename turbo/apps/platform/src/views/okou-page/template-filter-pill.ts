/**
 * The template picker's filter pills, shared by the workflow tab and the intro
 * video style gallery. The two rows filter the same kind of surface — a wall of
 * cards below a search box — so they have to read as one control, which is what
 * stopped the intro video gallery from keeping its own outlined toggle buttons.
 *
 * The row's own padding stays with the caller: each tab indents its content to
 * a different gutter.
 */
export const TEMPLATE_FILTER_PILL_ROW = "flex flex-wrap items-center gap-1.5";
export const TEMPLATE_FILTER_PILL =
  "h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors";
export const TEMPLATE_FILTER_PILL_ACTIVE = "bg-muted text-foreground";
export const TEMPLATE_FILTER_PILL_IDLE =
  "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground";
