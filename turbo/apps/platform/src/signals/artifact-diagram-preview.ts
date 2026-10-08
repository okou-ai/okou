import { command, computed, state } from "ccstate";
import { createObjectUrlResource } from "./object-url-resource.ts";
import { resetSignal } from "./utils.ts";
import { createZoomableImageCanvasSignals } from "./zoomable-image-canvas.ts";
import { downloadAttachmentUrl } from "../views/okou-page/attachment-url.ts";

export interface ArtifactDiagramPreview {
  readonly url: string;
  readonly filename: string;
  readonly trigger: HTMLElement;
}

/** A document owns its diagram independently of its own preview and layout. */
export function createArtifactDiagramPreviewSignals() {
  const current$ = state<ArtifactDiagramPreview | null>(null);
  const visible$ = state(false);
  const expanded$ = state(false);
  const resetResource$ = resetSignal();
  const resetDownload$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();

  const dispose$ = command(({ set }) => {
    set(current$, null);
    set(visible$, false);
    set(expanded$, false);
    set(resetDownload$);
    set(resetResource$);
    set(imageCanvas.reset$);
  });
  const open$ = command(
    (
      { get, set },
      file: File,
      trigger: HTMLElement,
      parentSignal: AbortSignal,
    ) => {
      parentSignal.throwIfAborted();
      set(dispose$);
      const signal = set(resetResource$, parentSignal);
      const current = {
        url: createObjectUrlResource(file, signal).url,
        filename: file.name,
        trigger,
      };
      set(current$, current);
      set(visible$, true);
      signal.addEventListener(
        "abort",
        () => {
          if (get(current$) === current) {
            set(dispose$);
          }
        },
        { once: true },
      );
    },
  );
  const close$ = command(({ set }) => {
    set(visible$, false);
    set(resetDownload$);
  });
  const finishClose$ = command(
    ({ get, set }, current: ArtifactDiagramPreview, open: boolean) => {
      // A previous dialog's exit animation must not dispose a newer diagram.
      if (!open && !get(visible$) && get(current$) === current) {
        set(dispose$);
      }
    },
  );
  const restoreFocus$ = command(({ get }, current: ArtifactDiagramPreview) => {
    if (
      !get(visible$) &&
      (get(current$) === current || get(current$) === null) &&
      current.trigger.isConnected
    ) {
      // Base UI restores this target after removing modal inertness, using preventScroll.
      return current.trigger;
    }
    return false as const;
  });
  const download$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const current = get(current$);
    if (current && get(visible$)) {
      const signal = set(resetDownload$, parentSignal);
      await downloadAttachmentUrl(
        current.url,
        signal,
        current.filename,
        "native",
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
    expanded$: computed((get) => {
      return get(expanded$);
    }),
    toggleExpanded$: command(({ get, set }) => {
      set(expanded$, !get(expanded$));
    }),
    open$,
    close$,
    finishClose$,
    restoreFocus$,
    dispose$,
    download$,
    imageCanvas,
  };
}

export type ArtifactDiagramPreviewSignals = ReturnType<
  typeof createArtifactDiagramPreviewSignals
>;
