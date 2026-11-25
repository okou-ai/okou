import { command, computed, state } from "ccstate";
import { createArtifactDiagramPreviewSignals } from "../artifact-diagram-preview.ts";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";
import { refreshWorkspaceLayout$ } from "../chat-page/workspace-layout.ts";
import {
  createCatalogArtifactPreviewSignals,
  createCatalogSharingRefresh$,
} from "./artifact-catalog-preview.ts";
import type { ArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

interface CatalogSidebarSession {
  readonly artifactId: string;
  readonly ownerSignal: AbortSignal;
}

/** The org-wide catalog owns a preview without inventing a chat thread. */
export function createArtifactCatalogSidebarSignals(
  catalog: ArtifactCatalogSignals,
) {
  const internalSession$ = state<CatalogSidebarSession | null>(null);
  const internalFullscreen$ = state(false);
  const resetOpenSignal$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();
  const diagram = createArtifactDiagramPreviewSignals();
  const preview = createCatalogArtifactPreviewSignals(catalog, diagram.open$);
  const readOwner$ = command(({ get }) => {
    return get(internalSession$)?.ownerSignal;
  });
  const refreshSharing$ = createCatalogSharingRefresh$(catalog, readOwner$);

  const close$ = command(({ get, set }) => {
    set(resetOpenSignal$);
    set(internalSession$, null);
    set(internalFullscreen$, false);
    set(catalog.selectArtifact$, null);
    set(imageCanvas.reset$);
    set(diagram.dispose$);
    detach(
      set(refreshWorkspaceLayout$, get(pageSignal$)),
      Reason.DomCallback,
      "catalog sidebar dismissal",
    );
  });

  return {
    open$: computed((get) => {
      return get(internalSession$) !== null;
    }),
    openArtifact$: command(
      async ({ get, set }, artifactId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const openSignal = set(resetOpenSignal$, signal);
        set(diagram.dispose$);
        openSignal.addEventListener(
          "abort",
          () => {
            set(diagram.dispose$);
          },
          { once: true },
        );
        set(imageCanvas.reset$);
        set(catalog.selectArtifact$, artifactId);
        set(internalSession$, { artifactId, ownerSignal: openSignal });
        const detail = await get(catalog.selectedArtifactDetail$);
        signal.throwIfAborted();
        openSignal.throwIfAborted();
        if (!detail) {
          return;
        }
        if (detail.kind === "shared-thread") {
          window.location.assign(
            `/share/threads/${encodeURIComponent(detail.sharedThread.id)}`,
          );
          return;
        }
        await set(refreshSharing$, openSignal);
        signal.throwIfAborted();
        openSignal.throwIfAborted();
        const selectedPreview = await set(
          catalog.ensureSelectedArtifactPreview$,
          artifactId,
          openSignal,
        );
        signal.throwIfAborted();
        openSignal.throwIfAborted();
        if (selectedPreview) {
          await set(
            selectedPreview.refreshOnOpen$,
            preview.contentReady$,
            openSignal,
          );
          signal.throwIfAborted();
          openSignal.throwIfAborted();
        }
        await set(refreshWorkspaceLayout$, openSignal);
      },
    ),
    close$,
    refreshSharing$,
    fullscreen$: computed((get) => {
      return get(internalFullscreen$);
    }),
    toggleFullscreen$: command(({ get, set }) => {
      set(imageCanvas.reset$);
      set(internalFullscreen$, (fullscreen) => {
        return !fullscreen;
      });
      detach(
        set(refreshWorkspaceLayout$, get(pageSignal$)),
        Reason.DomCallback,
        "catalog sidebar fullscreen",
      );
    }),
    detail$: catalog.selectedArtifactDetail$,
    imageCanvas,
    diagram,
    preview,
  };
}
