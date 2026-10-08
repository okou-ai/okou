import type { Root } from "hast";
import { MarkdownEventBody } from "./markdown.tsx";

/** A reading target after leaving an inline diagram's keyboard controls. */
export function ArtifactMarkdownDocument({ tree }: { readonly tree: Root }) {
  return (
    <div
      role="document"
      tabIndex={-1}
      className="h-full overflow-auto p-6 outline-none"
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
      <MarkdownEventBody tree={tree} mediaPreview={false} />
    </div>
  );
}
