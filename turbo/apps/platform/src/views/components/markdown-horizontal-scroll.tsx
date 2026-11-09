import { ScrollArea } from "@base-ui/react/scroll-area";
import { ScrollBar } from "@okouai/ui";
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
 * Base UI makes the viewport focusable only while it overflows, so keyboard
 * scrolling keeps working; the ring is inset so the block's rounded clip
 * cannot hide it. Overscroll is contained only while there is something to
 * scroll, so a swipe across a block that fits still reaches the page.
 */
export function MarkdownHorizontalScroll({
  className,
  contentClassName,
  children,
}: {
  readonly className?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <ScrollArea.Root className={className}>
      <ScrollArea.Viewport
        data-slot="scroll-area-viewport"
        className="rounded-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-has-overflow-x:overscroll-x-contain"
      >
        <ScrollArea.Content className={contentClassName}>
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollBar orientation="horizontal" />
    </ScrollArea.Root>
  );
}
