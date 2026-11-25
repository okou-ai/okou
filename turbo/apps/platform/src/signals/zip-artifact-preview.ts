import { command, computed, state, type Computed } from "ccstate";
import { readZipArtifact, type ZipArtifactEntry } from "../lib/zip-artifact.ts";
import { createArtifactDiagramPreviewSignals } from "./artifact-diagram-preview.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { createObjectUrlResource } from "./object-url-resource.ts";
import { createMarkdownPreviewTree } from "./markdown-preview-tree.ts";
import {
  createTextPreviewComputedFromBlob,
  isTextPreviewKind,
} from "./text-preview.ts";
import { onRef, resetSignal } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";
import { createZoomableImageCanvasSignals } from "./zoomable-image-canvas.ts";
import type { AttachmentLightboxState } from "./okou-page/attachment-chips.ts";

function createZipArtifactPreview(
  entries: Promise<readonly ZipArtifactEntry[]>,
  owner: AbortSignal,
) {
  const entries$ = computed(() => {
    return entries;
  });
  const diagram = createArtifactDiagramPreviewSignals();
  const imageCanvas = createZoomableImageCanvasSignals();
  const resetSelection$ = resetSignal();
  const selection$ = state<{
    readonly path: string;
    readonly preview$: Computed<Promise<AttachmentLightboxState>>;
  } | null>(null);

  async function readEntryPreview(
    path: string,
    entry: NonNullable<ZipArtifactEntry["preview"]>,
    signal: AbortSignal,
  ): Promise<AttachmentLightboxState> {
    const blob = await entry.read(signal);
    const url = createObjectUrlResource(blob, signal).url;
    const preview = createAttachmentPreviewSignals(url, {
      contentType: blob.type,
    });
    const base = { url, filename: path, preview, ...preview };
    if (isTextPreviewKind(entry.kind)) {
      const text$ = createTextPreviewComputedFromBlob(blob);
      if (entry.kind === "markdown") {
        return {
          ...base,
          kind: entry.kind,
          text$,
          markdownTree$: createMarkdownPreviewTree(text$, diagram.open$),
        };
      }
      return { ...base, kind: entry.kind, text$ };
    }
    return { ...base, kind: entry.kind };
  }

  const toggleEntry$ = command(
    async ({ get, set }, entry: ZipArtifactEntry, signal: AbortSignal) => {
      if (!entry.preview) {
        return;
      }
      set(diagram.dispose$);
      set(imageCanvas.reset$);
      if (entry.path === get(selection$)?.path) {
        set(resetSelection$);
        set(selection$, null);
        return;
      }
      const selectionSignal = set(resetSelection$, owner, signal);
      const read = readEntryPreview(entry.path, entry.preview, selectionSignal);
      set(selection$, {
        path: entry.path,
        preview$: computed(() => {
          return read;
        }),
      });
      await Promise.allSettled([read]);
    },
  );
  const dispose$ = command(({ set }) => {
    set(diagram.dispose$);
  });
  return {
    entries$,
    selection$,
    toggleEntry$,
    diagram,
    imageCanvas,
    dispose$,
  };
}

export type ZipArtifactPreviewSignals = ReturnType<
  typeof createZipArtifactPreview
>;

export const revealSelectedZipEntry$ = onRef<HTMLButtonElement>(
  command((_, button: HTMLButtonElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    const list = button.closest("ul");
    if (!list) {
      return;
    }
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    const row = button.getBoundingClientRect();
    // The list becomes shorter on first selection. Scroll just its own
    // viewport so the focused row stays visible as the preview opens.
    if (row.top < top) {
      list.scrollTop += row.top - top;
    } else if (row.bottom > bottom) {
      list.scrollTop += row.bottom - bottom;
    }
  }),
);

/** The ref mounting the preview owns its reads and every extracted object URL. */
export function createZipArtifactPreviewScope(
  resourceUrl$: Computed<Promise<string | null>>,
  size$?: Computed<Promise<number | undefined>>,
) {
  const current$ = state<ZipArtifactPreviewSignals | null>(null);
  const mountRef$ = onRef(
    command(
      async ({ get, set }, _element: HTMLDivElement, lifetime: AbortSignal) => {
        const owner = AbortSignal.any([get(pageSignal$), lifetime]);
        const url = await get(resourceUrl$);
        const size = size$ ? await get(size$) : undefined;
        owner.throwIfAborted();
        if (!url) {
          return;
        }
        const entries = readZipArtifact(url, size, owner);
        const preview = createZipArtifactPreview(entries, owner);
        owner.addEventListener(
          "abort",
          () => {
            set(preview.dispose$);
            if (get(current$) === preview) {
              set(current$, null);
            }
          },
          { once: true },
        );
        set(current$, preview);
        await Promise.allSettled([entries]);
      },
    ),
  );
  return { current$, mountRef$ };
}

export type ZipArtifactPreviewScope = ReturnType<
  typeof createZipArtifactPreviewScope
>;
