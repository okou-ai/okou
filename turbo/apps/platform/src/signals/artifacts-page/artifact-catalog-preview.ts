import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { computed } from "ccstate";
import type { ArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";
import type { MermaidDiagramPreviewCommand } from "../mermaid-diagram.ts";
import { createMarkdownPreviewTree } from "../markdown-preview-tree.ts";
import { fetchPreviewText, isTextPreviewKind } from "../text-preview.ts";

import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../chat-page/parse-body-blocks.ts";

interface ArtifactDetailPreview {
  readonly kind: BodyPreviewKind;
  readonly url: string;
  readonly filename: string;
}

/** Resource and text graphs shared by the page and thread catalog sidebars. */
export function createCatalogArtifactPreviewSignals(
  artifactCatalog: ArtifactCatalogSignals,
  openDiagram$: MermaidDiagramPreviewCommand,
) {
  const resourceUrl$ = computed(async (get) => {
    const preview = get(artifactCatalog.selectedArtifactPreview$);
    return preview ? await get(preview.resourceUrl$) : null;
  });
  const shareUrl$ = computed(async (get) => {
    const preview = get(artifactCatalog.selectedArtifactPreview$);
    return preview ? await get(preview.shareUrl$) : null;
  });
  const text$ = computed(async (get): Promise<string> => {
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    if (!detail) {
      throw new Error("Selected artifact is unavailable");
    }
    const preview = artifactDetailPreview(detail);
    if (!isTextPreviewKind(preview.kind)) {
      throw new Error("Selected artifact is not a text preview");
    }
    const resourceUrl = await get(resourceUrl$);
    if (!resourceUrl) {
      throw new Error("Selected artifact preview is unavailable");
    }
    return fetchPreviewText(resourceUrl);
  });
  return {
    resourceUrl$,
    shareUrl$,
    text$,
    markdownTree$: createMarkdownPreviewTree(text$, openDiagram$),
  };
}

/** One preview descriptor shared by the catalog dialog and sidebars. */
export function artifactDetailPreview(
  detail: ArtifactDetail,
): ArtifactDetailPreview {
  if (detail.kind === "shared-thread") {
    return {
      kind: "html",
      url: new URL(
        `/share/threads/${encodeURIComponent(detail.sharedThread.id)}`,
        window.location.origin,
      ).toString(),
      filename: detail.title,
    };
  }
  if (detail.kind === "hosted-site" || detail.kind === "presentation") {
    return {
      kind: "html",
      url: detail.site.url,
      filename: detail.title,
    };
  }
  return {
    kind: classifyChatAttachment({
      filename: detail.file.filename,
      url: detail.file.url,
      contentType: detail.file.contentType,
    }),
    url: publicAttachmentUrl(detail.file.url),
    filename: detail.file.filename,
  };
}
