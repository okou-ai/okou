import { command, computed, state } from "ccstate";

import type { ArtifactSignals } from "./chat-page/artifact-card-signals.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { createMarkdownPreviewTree } from "./markdown-preview-tree.ts";
import type { MermaidDiagramPreviewCommand } from "./mermaid-diagram.ts";
import { createArtifactDiagramPreviewSignals } from "./artifact-diagram-preview.ts";
import type { AttachmentLightboxState } from "./okou-page/attachment-chips.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "./text-preview.ts";
import { createZoomableImageCanvasSignals } from "./zoomable-image-canvas.ts";
import {
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
} from "../views/okou-page/attachment-url.ts";
import { resetSignal } from "./utils.ts";

export interface PublicArtifactPreview {
  readonly title: string;
  readonly preview: AttachmentLightboxState & { readonly filename: string };
}

/**
 * Hand the dialog what the kind's own preview surface reads: a text body needs
 * its content, and a Markdown body needs the tree that content parses into.
 * Every other kind renders from the resolved resource alone.
 */
function storedArtifactPreview(
  artifact: ArtifactSignals,
  label: string,
  openDiagram$: MermaidDiagramPreviewCommand,
): PublicArtifactPreview {
  const base = {
    ...artifact,
    preview: artifact,
    url: new URL(artifact.url, location.origin).href,
  };
  const title = label.trim() || artifact.filename;
  const kind = artifact.kind;
  if (!isTextPreviewKind(kind)) {
    return { title, preview: { ...base, kind } };
  }
  // Read the body through the credential the card already resolved: the URL
  // argument only applies when no resource is supplied.
  const text$ = createTextPreviewComputed(base.url, artifact.resourceUrl$);
  return {
    title,
    preview:
      kind === "markdown"
        ? {
            ...base,
            kind,
            text$,
            markdownTree$: createMarkdownPreviewTree(text$, openDiagram$),
          }
        : { ...base, kind, text$ },
  };
}

const downloadStoredArtifact$ = command(
  async (
    { get },
    preview: PublicArtifactPreview["preview"],
    signal: AbortSignal,
  ) => {
    // A user action resolves a fresh signature; the card may have been open
    // longer than the preview grant. Never use this credential for copying.
    const download = createAttachmentPreviewSignals(preview.url);
    const token = await get(download.presignedToken$);
    signal.throwIfAborted();
    const url = token?.downloadUrl ?? (await get(download.resourceUrl$));
    signal.throwIfAborted();
    await downloadAttachmentUrl(
      url,
      signal,
      preview.filename,
      token?.downloadUrl ? "native" : "blob",
      "default",
    );
  },
);

/** One public page owns its preview and cancels actions on close/leave. */
export function createPublicArtifactPreviewSignals() {
  const current$ = state<PublicArtifactPreview | null>(null);
  const visible$ = state(false);
  const fullscreen$ = state(false);
  const resetOwner$ = resetSignal();
  const resetCopy$ = resetSignal();
  const resetDownload$ = resetSignal();
  const diagram = createArtifactDiagramPreviewSignals();
  const imageCanvas = createZoomableImageCanvasSignals();

  const beginOpen$ = command(({ set }) => {
    set(diagram.dispose$);
    set(resetCopy$);
    set(resetDownload$);
    set(imageCanvas.reset$);
    set(fullscreen$, false);
  });
  const open$ = command(
    (
      { set },
      artifact: ArtifactSignals,
      label: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      set(beginOpen$);
      set(current$, storedArtifactPreview(artifact, label, diagram.open$));
      set(visible$, true);
    },
  );
  const close$ = command(({ set }) => {
    set(diagram.dispose$);
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
      await set(downloadStoredArtifact$, current.preview, signal);
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
    openDiagram$: diagram.open$,
    diagram,
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

export type PublicArtifactPreviewSignals = ReturnType<
  typeof createPublicArtifactPreviewSignals
>;
