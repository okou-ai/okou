import { command, computed, state } from "ccstate";

import type { ArtifactSignals } from "./chat-page/artifact-card-signals.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { createMarkdownPreviewTree } from "./markdown-preview-tree.ts";
import type { MermaidDiagramPreviewCommand } from "./mermaid-diagram.ts";
import { createObjectUrlResource } from "./object-url-resource.ts";
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
  /**
   * `rendered` marks a preview the viewer's own browser produced — a diagram —
   * whose object URL is the bytes themselves: there is no address worth
   * copying, and nothing to fetch before saving it. A `stored` artifact keeps
   * its stable reference and its signed resource.
   */
  readonly source: "stored" | "rendered";
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
    return { title, source: "stored", preview: { ...base, kind } };
  }
  // Read the body through the credential the card already resolved: the URL
  // argument only applies when no resource is supplied.
  const text$ = createTextPreviewComputed(base.url, artifact.resourceUrl$);
  return {
    title,
    source: "stored",
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

/** The dialog's view of a diagram this browser rendered into an object URL. */
function diagramPreview(file: File, url: string): PublicArtifactPreview {
  const preview = createAttachmentPreviewSignals(url, {
    contentType: file.type,
  });
  return {
    title: file.name,
    source: "rendered",
    preview: { ...preview, preview, kind: "image", url, filename: file.name },
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
  // Owns the object URL of a browser-produced preview until the next one opens
  // or the page goes away.
  const resetResource$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();

  const beginOpen$ = command(({ set }) => {
    set(resetCopy$);
    set(resetDownload$);
    set(imageCanvas.reset$);
    set(fullscreen$, false);
  });
  const openDiagram$ = command(
    ({ set }, file: File, parentSignal: AbortSignal) => {
      parentSignal.throwIfAborted();
      set(beginOpen$);
      const signal = set(resetResource$, parentSignal);
      const { url } = createObjectUrlResource(file, signal);
      set(current$, diagramPreview(file, url));
      set(visible$, true);
    },
  );
  const open$ = command(
    (
      { set },
      artifact: ArtifactSignals,
      label: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      set(beginOpen$);
      set(current$, storedArtifactPreview(artifact, label, openDiagram$));
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
    set(resetResource$);
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
      await (current.source === "rendered"
        ? // The object URL already holds the bytes, and an anchor download of
          // one cannot navigate the page away the way a media URL can.
          downloadAttachmentUrl(
            current.preview.url,
            signal,
            current.preview.filename,
            "native",
          )
        : set(downloadStoredArtifact$, current.preview, signal));
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
    openDiagram$,
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
