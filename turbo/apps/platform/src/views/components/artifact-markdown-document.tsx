import { cn } from "@okouai/ui";
import type { Root } from "hast";
import { MarkdownEventBody } from "./markdown.tsx";

/** A reading target after leaving an inline diagram's keyboard controls. */
export function ArtifactMarkdownDocument({ tree }: { readonly tree: Root }) {
  return (
    <div
      role="document"
      tabIndex={-1}
      className="h-full overflow-auto p-6 text-base leading-[1.75] outline-none"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          event.target instanceof HTMLElement &&
          event.target.dataset.slot === "mermaid-diagram-trigger"
        ) {
          event.currentTarget.focus({ preventScroll: true });
          // Leave Escape available to the owning dialog or fullscreen viewer.
        }
      }}
    >
      <MarkdownEventBody
        className={cn(
          // Important utilities override the unlayered Markdown typography;
          // embedded UI keeps ownership of its own headings.
          "[&_:is(h1,h2,h3,h4,h5,h6):not(:where([data-markdown-ui]_*))]:mb-3! [&_:is(h1,h2,h3,h4,h5,h6):not(:where([data-markdown-ui]_*))]:leading-[1.4]! [&_:is(h1,h2,h3,h4,h5,h6):not(:where([data-markdown-ui]_*))]:text-foreground! [&_:is(h1,h2,h3,h4,h5,h6):not(:where([data-markdown-ui]_*))]:[overflow-wrap:anywhere]",
          "[&_:is(h1,h2):not(:where([data-markdown-ui]_*))]:mt-8! [&_:is(h3,h4,h5,h6):not(:where([data-markdown-ui]_*))]:mt-6!",
          "[&_h1:not(:where([data-markdown-ui]_*))]:text-[2em]! [&_h1:not(:where([data-markdown-ui]_*))]:font-bold! [&_:is(h2,h3,h4,h5):not(:where([data-markdown-ui]_*))]:font-semibold! [&_h6:not(:where([data-markdown-ui]_*))]:font-medium!",
          "[&_h2:not(:where([data-markdown-ui]_*))]:text-[1.5em]! [&_h3:not(:where([data-markdown-ui]_*))]:text-[1.25em]! [&_h4:not(:where([data-markdown-ui]_*))]:text-[1.125em]! [&_:is(h5,h6):not(:where([data-markdown-ui]_*))]:text-[1em]!",
          "[&>*:first-child]:mt-0! [&>*:last-child]:mb-0! [&_blockquote:not(:where([data-markdown-ui]_*))>*:first-child]:mt-0! [&_blockquote:not(:where([data-markdown-ui]_*))>*:last-child]:mb-0!",
        )}
        tree={tree}
        mediaPreview={false}
      />
    </div>
  );
}
