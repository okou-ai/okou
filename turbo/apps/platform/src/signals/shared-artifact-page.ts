import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createMarkdownPreviewTree } from "./markdown-preview-tree.ts";
import type { AttachmentLightboxState } from "./okou-page/attachment-chips.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "./text-preview.ts";
import { createZoomableImageCanvasSignals } from "./zoomable-image-canvas.ts";

export interface SharedArtifactPreview {
  readonly filename: string;
  readonly preview: AttachmentLightboxState;
}

export function createSharedArtifactPreview(
  artifact: {
    readonly filename: string;
    readonly contentType: string;
    readonly url: string;
    readonly expiresAt: string;
  },
  referenceUrl: string,
): SharedArtifactPreview {
  const kind = classifyChatAttachment(artifact);
  const contentUrl = new URL(artifact.url);
  contentUrl.hash = new URL(referenceUrl).hash;
  const base = {
    filename: artifact.filename,
    url: referenceUrl,
    ...createAttachmentPreviewSignals(referenceUrl, {
      contentType: artifact.contentType,
      resolvedToken: {
        token: contentUrl.href,
        expiresAt: artifact.expiresAt,
        publicUrl: null,
      },
    }),
  };
  let preview: AttachmentLightboxState;
  if (isTextPreviewKind(kind)) {
    const text$ = createTextPreviewComputed(referenceUrl, base.resourceUrl$);
    preview =
      kind === "markdown"
        ? {
            ...base,
            kind,
            text$,
            markdownTree$: createMarkdownPreviewTree(text$),
          }
        : { ...base, kind, text$ };
  } else {
    preview = { ...base, kind };
  }
  return {
    filename: artifact.filename,
    preview,
  };
}

export function createSharedArtifactViewerSignals() {
  return {
    imageCanvas: createZoomableImageCanvasSignals(),
  };
}

export type SharedArtifactViewerSignals = ReturnType<
  typeof createSharedArtifactViewerSignals
>;
