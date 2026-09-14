import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createMarkdownPreviewTree } from "./markdown-preview-tree.ts";
import type { AttachmentLightboxState } from "./okou-page/attachment-chips.ts";
import { writeToClipboard } from "./okou-page/clipboard.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "./text-preview.ts";
import { onRef } from "./utils.ts";
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
  signal: AbortSignal,
): SharedArtifactPreview {
  const kind = classifyChatAttachment(artifact);
  const contentUrl = new URL(artifact.url);
  contentUrl.hash = new URL(referenceUrl).hash;
  const base = {
    filename: artifact.filename,
    url: referenceUrl,
    ...createAttachmentPreviewSignals(referenceUrl, {
      token: contentUrl.href,
      expiresAt: artifact.expiresAt,
      publicUrl: null,
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
            markdownTree$: createMarkdownPreviewTree(text$, signal),
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

export const copySharedArtifactLink$ = command(
  async (_context, signal: AbortSignal) => {
    // Read the app address at click time; temporary preview URLs never leave
    // the viewer through the share action.
    const copied = await writeToClipboard(window.location.href);
    signal.throwIfAborted();
    if (copied) {
      toast.success(
        i18n.t(($) => {
          return $.artifacts.toasts.linkCopied;
        }),
      );
      return;
    }
    toast.error(
      i18n.t(($) => {
        return $.artifacts.toasts.copyLinkFailed;
      }),
    );
  },
);

export function createSharedArtifactViewerSignals() {
  const fullscreen$ = state(false);
  const fullscreenAvailable$ = state(false);
  return {
    imageCanvas: createZoomableImageCanvasSignals(),
    fullscreen$: computed((get) => {
      return get(fullscreen$);
    }),
    fullscreenAvailable$: computed((get) => {
      return get(fullscreenAvailable$);
    }),
    mountRef$: onRef(
      command(({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
        set(fullscreenAvailable$, document.fullscreenEnabled === true);
        const updateFullscreen = () => {
          set(fullscreen$, Boolean(document.fullscreenElement));
        };
        updateFullscreen();
        document.addEventListener("fullscreenchange", updateFullscreen, {
          signal,
        });
      }),
    ),
    toggleFullscreen$: command(async (_context, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // Include body portals so download menus and feedback remain
        // usable while viewing the artifact in fullscreen.
        await document.documentElement.requestFullscreen();
      }
      signal.throwIfAborted();
    }),
  };
}

export type SharedArtifactViewerSignals = ReturnType<
  typeof createSharedArtifactViewerSignals
>;
