import { ScrollArea } from "@base-ui/react/scroll-area";
import { cn, ScrollBar } from "@okouai/ui";
import type { ReactNode } from "react";

/**
 * Horizontal overflow for wide Markdown blocks: fenced code and tables.
 *
 * A native `overflow-x: auto` scroller reserves layout space for its scrollbar
 * wherever the OS shows scroll bars permanently (macOS with a mouse attached,
 * or "Show scroll bars: Always"). Such a block grew by the scrollbar's
 * thickness the moment a line overflowed, mid-stream or when the column
 * narrowed, and the transcript below it jumped. Base UI hides the native
 * scrollbar and overlays the shared `ScrollBar`, so a block's height no longer
 * depends on whether it overflows, in any browser or scroll-bar mode.
 *
 * `phrasing` renders every part as a block-level `span`, for a caller inside
 * a `pre`, whose content model admits phrasing content only. A table cannot
 * sit inside a `span`, so the default keeps `div`s.
 *
 * The root clips to its own radius, so the overlaid scrollbar, which is placed
 * against the root's box rather than inside the viewport, never paints past a
 * rounded corner.
 *
 * Base UI makes the viewport focusable only while it overflows, so keyboard
 * scrolling keeps working; the ring is inset so the block's rounded clip
 * cannot hide it. Overscroll is contained only while there is something to
 * scroll, so a swipe across a block that fits still reaches the page.
 */
export function MarkdownHorizontalScroll({
  className,
  contentClassName,
  phrasing = false,
  children,
}: {
  readonly className?: string;
  readonly contentClassName?: string;
  readonly phrasing?: boolean;
  readonly children: ReactNode;
}) {
  const host = phrasing ? <span /> : <div />;
  const display = phrasing && "block";
  return (
    <ScrollArea.Root
      render={host}
      className={cn(display, "overflow-clip", className)}
    >
      <ScrollArea.Viewport
        render={host}
        data-slot="scroll-area-viewport"
        className={cn(
          display,
          "rounded-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-has-overflow-x:overscroll-x-contain",
        )}
      >
        <ScrollArea.Content
          render={host}
          className={cn(display, contentClassName)}
        >
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollBar orientation="horizontal" render={host} />
    </ScrollArea.Root>
  );
}
