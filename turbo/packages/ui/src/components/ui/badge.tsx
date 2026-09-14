import { useRender } from "@base-ui/react/use-render";

import { cn } from "../../lib/utils";

/**
 * Inline badges and tags: role labels, status pills, version chips, and
 * diagnostic key/value chips.
 *
 * The badge owns its geometry — display, alignment, radius, padding, and line
 * height — so its box is a function of its own text size. Callers that only set
 * a font size (`text-[11px]` carries no paired line height) previously let an
 * ancestor's `line-height` decide the box: the same badge measured 22px, 26px,
 * or 34px tall depending on an ancestor two levels up.
 *
 * `align-middle` only applies where the badge is a real inline box; flex and
 * grid items ignore it.
 *
 * Typography and foreground stay with the caller, because a badge reads as
 * secondary beside body text in one place and as the value itself in another.
 *
 * The icon rule and the slot follow shadcn's badge, which this package's
 * components come from. The rest of shadcn's badge does not fit: it bakes in
 * `text-xs font-medium`, which the diagnostic chips inherit from their row
 * instead, and `whitespace-nowrap overflow-hidden`, which would stop the long
 * key/value chips from wrapping.
 */
const badgeClassName =
  "inline-flex items-center gap-1 rounded-md border border-surface-border bg-gray-0 px-2 py-0.5 align-middle [&>svg]:size-3";

export type BadgeProps = useRender.ComponentProps<"span">;

/** Renders a `span` unless `render` supplies another element. */
export function Badge({ className, render, ref, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: "span",
    props: {
      "data-slot": "badge",
      ...props,
      // Font-size utilities remove earlier leading utilities during merging.
      // Keep the badge's own line height after caller typography.
      className: cn(badgeClassName, className, "leading-snug"),
    },
    ref,
    render,
    state: {},
  });
}
