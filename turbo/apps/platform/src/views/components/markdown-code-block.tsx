import type { ComponentPropsWithoutRef } from "react";
import { MarkdownHorizontalScroll } from "./markdown-horizontal-scroll.tsx";

/**
 * A Markdown code block. The vendored sheet made `pre > code` the scroller;
 * the code now scrolls inside `MarkdownHorizontalScroll`, which also ends that
 * selector's match, so `code` is inline and the 16px inset moves onto the
 * scroll content.
 *
 * The copy button arrives as the last child and stays in the scroll content,
 * but its `absolute` box is placed against the positioned scroll-area root.
 * That root is an ancestor of the scrolling viewport, so the viewport neither
 * scrolls nor clips the button: it keeps the block's corner while the code
 * scrolls, and `pre:hover` still reveals it.
 */
export function MarkdownCodeBlock({
  children,
  ...props
}: ComponentPropsWithoutRef<"pre">) {
  return (
    <pre {...props}>
      <MarkdownHorizontalScroll className="relative" contentClassName="p-4">
        {children}
      </MarkdownHorizontalScroll>
    </pre>
  );
}
