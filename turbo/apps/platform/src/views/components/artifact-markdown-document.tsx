import type { Root } from "hast";
import { useSet } from "ccstate-react";
import { documentPreviewRef$ } from "../../signals/document-preview.ts";
import { MarkdownEventBody } from "./markdown.tsx";

/** A reading target after leaving an inline diagram's keyboard controls. */
export function ArtifactMarkdownDocument({ tree }: { readonly tree: Root }) {
  const documentPreviewRef = useSet(documentPreviewRef$);
  return (
    <div
      ref={documentPreviewRef}
      role="document"
      tabIndex={-1}
      className="h-full touch-pan-x touch-pan-y p-6 outline-none"
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
