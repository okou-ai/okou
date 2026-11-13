import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { createArtifactDiagramPreviewSignals } from "../artifact-diagram-preview.ts";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";
import { refreshWorkspaceLayout$ } from "../chat-page/workspace-layout.ts";
import { createCatalogArtifactPreviewSignals } from "./artifact-catalog-preview.ts";
import type { ArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

/** The org-wide catalog owns a preview without inventing a chat thread. */
export function createArtifactCatalogSidebarSignals(
  catalog: ArtifactCatalogSignals,
) {
  const internalOpen$ = state(false);
  const internalFullscreen$ = state(false);
  const resetOpenSignal$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();
  const diagram = createArtifactDiagramPreviewSignals();
  const preview = createCatalogArtifactPreviewSignals(catalog, diagram.open$);

  const close$ = command(({ get, set }) => {
    set(resetOpenSignal$);
    set(internalOpen$, false);
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
      return (
        get(featureSwitch$)[FeatureSwitchKey.ArtifactSidebarPreview] &&
        get(internalOpen$)
      );
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
        set(internalOpen$, true);
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
        await set(
          catalog.ensureSelectedArtifactPreview$,
          artifactId,
          openSignal,
        );
        signal.throwIfAborted();
        openSignal.throwIfAborted();
        await set(refreshWorkspaceLayout$, openSignal);
      },
    ),
    close$,
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
