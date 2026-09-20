import { command, computed, state } from "ccstate";

import type { ArtifactSignals } from "../chat-page/artifact-card-signals.ts";
import { createAttachmentPreviewSignals } from "../attachment-resource-url.ts";
import type { AttachmentLightboxState } from "../okou-page/attachment-chips.ts";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";
import {
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
} from "../../views/okou-page/attachment-url.ts";
import { resetSignal } from "../utils.ts";

export interface SharedThreadArtifactPreview {
  readonly title: string;
  readonly preview: AttachmentLightboxState & { readonly filename: string };
}

/** One public conversation owns its preview and cancels actions on close/leave. */
export function createSharedThreadArtifactPreviewSignals() {
  const current$ = state<SharedThreadArtifactPreview | null>(null);
  const visible$ = state(false);
  const fullscreen$ = state(false);
  const resetOwner$ = resetSignal();
  const resetCopy$ = resetSignal();
  const resetDownload$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();

  const open$ = command(
    (
      { set },
      artifact: ArtifactSignals,
      label: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (artifact.kind !== "html" && artifact.kind !== "video") {
        return;
      }
      set(resetCopy$);
      set(resetDownload$);
      set(imageCanvas.reset$);
      set(fullscreen$, false);
      set(current$, {
        title: label.trim() || artifact.filename,
        preview: {
          ...artifact,
          preview: artifact,
          kind: artifact.kind,
          url: new URL(artifact.url, location.origin).href,
        },
      });
      set(visible$, true);
    },
  );
  const close$ = command(({ set }) => {
    set(visible$, false);
    set(resetCopy$);
    set(resetDownload$);
  });
  const dispose$ = command(({ set }) => {
    set(close$);
    set(current$, null);
    set(fullscreen$, false);
    set(imageCanvas.reset$);
  });
  const initialize$ = command(({ set }, parentSignal: AbortSignal) => {
    parentSignal.throwIfAborted();
    const signal = set(resetOwner$, parentSignal);
    signal.addEventListener(
      "abort",
      () => {
        set(dispose$);
      },
      { once: true },
    );
  });
  const finishClose$ = command(({ get, set }, open: boolean) => {
    if (!open && !get(visible$)) {
      set(dispose$);
    }
  });
  const toggleFullscreen$ = command(({ get, set }) => {
    set(fullscreen$, !get(fullscreen$));
  });
  const copyLink$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const current = get(current$);
    if (current && get(visible$)) {
      const signal = set(resetCopy$, parentSignal);
      await copyAttachmentLinkToClipboard(
        current.preview.url,
        undefined,
        signal,
      );
    }
  });
  const download$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const current = get(current$);
    if (current && get(visible$)) {
      const signal = set(resetDownload$, parentSignal);
      // A user action resolves a fresh signature; the card may have been open
      // longer than the preview grant. Never use this credential for copying.
      const download = createAttachmentPreviewSignals(current.preview.url);
      const token = await get(download.presignedToken$);
      signal.throwIfAborted();
      const url = token?.downloadUrl ?? (await get(download.resourceUrl$));
      signal.throwIfAborted();
      await downloadAttachmentUrl(
        url,
        signal,
        current.preview.filename,
        token?.downloadUrl ? "native" : "blob",
        "default",
      );
    }
  });

  return {
    current$: computed((get) => {
      return get(current$);
    }),
    visible$: computed((get) => {
      return get(visible$);
    }),
    fullscreen$: computed((get) => {
      return get(fullscreen$);
    }),
    open$,
    close$,
    dispose$,
    initialize$,
    finishClose$,
    toggleFullscreen$,
    copyLink$,
    download$,
    imageCanvas,
  };
}

export type SharedThreadArtifactPreviewSignals = ReturnType<
  typeof createSharedThreadArtifactPreviewSignals
>;
