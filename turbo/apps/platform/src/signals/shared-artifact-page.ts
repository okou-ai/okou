import { command } from "ccstate";
import { createArtifactViewerFullscreenSignals } from "./artifact-viewer-fullscreen.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { clerk$ } from "./auth.ts";
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
  readonly publicUrl: string | null;
  readonly sharedThreadSnapshot: boolean;
}

export interface SharedArtifactContent {
  readonly filename: string;
  readonly contentType: string;
  readonly url: string;
  readonly expiresAt?: string;
  readonly sharedThreadSnapshot?: true;
}

export const signInToSharedArtifact$ = command(
  async ({ get }, returnUrl: string, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    window.location.assign(clerk.buildSignInUrl({ redirectUrl: returnUrl }));
  },
);

export function createSharedArtifactPreview(
  artifact: SharedArtifactContent,
  referenceUrl: string,
): SharedArtifactPreview {
  const kind = classifyChatAttachment(artifact);
  const contentUrl = new URL(artifact.url);
  contentUrl.hash = new URL(referenceUrl).hash;
  const base = {
    filename: artifact.filename,
    url: referenceUrl,
    ...(artifact.expiresAt === undefined
      ? createAttachmentPreviewSignals(contentUrl.href, {
          contentType: artifact.contentType,
        })
      : createAttachmentPreviewSignals(referenceUrl, {
          contentType: artifact.contentType,
          resolvedToken: {
            token: contentUrl.href,
            expiresAt: artifact.expiresAt,
            publicUrl: null,
          },
        })),
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
    publicUrl: artifact.expiresAt === undefined ? contentUrl.href : null,
    sharedThreadSnapshot: artifact.sharedThreadSnapshot === true,
  };
}

export function createSharedArtifactViewerSignals() {
  return {
    imageCanvas: createZoomableImageCanvasSignals(),
    fullscreen: createArtifactViewerFullscreenSignals(),
  };
}

export type SharedArtifactViewerSignals = ReturnType<
  typeof createSharedArtifactViewerSignals
>;
