import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { command, computed, type Command } from "ccstate";
import type { ArtifactCatalogViewSignals } from "./create-artifact-catalog-signals.ts";
import type { MermaidDiagramPreviewCommand } from "../mermaid-diagram.ts";
import { createMarkdownPreviewTree } from "../markdown-preview-tree.ts";
import { createZipArtifactPreviewScope } from "../zip-artifact-preview.ts";
import {
  fetchPreviewText,
  isTextPreviewKind,
  type TextPreviewContent,
} from "../text-preview.ts";

import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../chat-page/parse-body-blocks.ts";
import { selectArtifactPreviewSessions$ } from "../artifact-preview-sessions.ts";

interface ArtifactDetailPreview {
  readonly kind: BodyPreviewKind;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
}

/** Opening and publication notifications select the same preview-owned session. */
export function createCatalogPreviewSessionsRefresh$(
  catalog: ArtifactCatalogViewSignals,
  readOwner$: Command<AbortSignal | undefined, []>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const ownerSignal = set(readOwner$);
    if (!ownerSignal || ownerSignal.aborted) {
      return;
    }
    const detail = await get(catalog.selectedArtifactDetail$);
    signal.throwIfAborted();
    if (!detail || ownerSignal.aborted || set(readOwner$) !== ownerSignal) {
      return;
    }
    const url = artifactDetailPreview(detail).url;
    set(
      selectArtifactPreviewSessions$,
      "sidebar",
      {
        url,
        artifactId: detail.id,
        deletionIdentity: { artifactId: detail.id },
        fileId: "file" in detail ? detail.file.id : undefined,
      },
      ownerSignal,
    );
  });
}

/** Resource and text graphs shared by the page and thread catalog sidebars. */
export function createCatalogArtifactPreviewSignals(
  artifactCatalog: ArtifactCatalogViewSignals,
  openDiagram$: MermaidDiagramPreviewCommand,
  threadId?: string,
) {
  const resourceUrl$ = computed(async (get) => {
    const preview = get(artifactCatalog.selectedArtifactPreview$);
    return preview ? await get(preview.resourceUrl$) : null;
  });
  const imageUrl$ = computed(async (get) => {
    const preview = get(artifactCatalog.selectedArtifactPreview$);
    return preview ? await get(preview.imageUrl$) : null;
  });
  const shareUrl$ = computed(async (get) => {
    const preview = get(artifactCatalog.selectedArtifactPreview$);
    return preview ? await get(preview.shareUrl$) : null;
  });
  const size$ = computed(async (get) => {
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    return detail && "file" in detail ? detail.file.size : undefined;
  });
  const text$ = computed(async (get): Promise<TextPreviewContent> => {
    const resourceUrl = await get(resourceUrl$);
    if (!resourceUrl) {
      throw new Error("Selected artifact preview is unavailable");
    }
    return fetchPreviewText(resourceUrl);
  });
  const contentReady$ = computed(async (get) => {
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    if (detail && isTextPreviewKind(artifactDetailPreview(detail).kind)) {
      await get(text$);
    }
  });
  return {
    contentReady$,
    resourceUrl$,
    imageUrl$,
    shareUrl$,
    text$,
    markdownTree$: createMarkdownPreviewTree(text$, openDiagram$, threadId),
    zipPreview: createZipArtifactPreviewScope(resourceUrl$, size$),
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
      contentType: "text/html",
    };
  }
  if (detail.kind === "hosted-site" || detail.kind === "presentation") {
    return {
      kind: "html",
      url: detail.site.url,
      filename: detail.title,
      contentType: "text/html",
      artifactKind:
        detail.kind === "presentation" ? "presentation-html" : "hosted-site",
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
    contentType: detail.file.contentType,
  };
}
