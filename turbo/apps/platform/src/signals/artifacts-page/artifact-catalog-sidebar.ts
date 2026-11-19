import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { createArtifactDiagramPreviewSignals } from "../artifact-diagram-preview.ts";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";
import { detach, onRef, Reason, resetSignal } from "../utils.ts";
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
  const returnFocusTarget$ = state<{
    readonly artifactId: string;
    readonly trigger: HTMLElement | null;
  } | null>(null);
  const resetOpenSignal$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();
  const diagram = createArtifactDiagramPreviewSignals();
  const preview = createCatalogArtifactPreviewSignals(catalog, diagram.open$);

  const close$ = command(({ get, set }, restoreFocus = false) => {
    if (!restoreFocus) {
      set(returnFocusTarget$, null);
    }
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

  const loadPreview$ = command(
    async ({ get, set }, artifactId: string, signal: AbortSignal) => {
      const detail = await get(catalog.selectedArtifactDetail$);
      signal.throwIfAborted();
      if (!detail) {
        return;
      }
      if (detail.kind === "shared-thread") {
        window.location.assign(
          `/share/threads/${encodeURIComponent(detail.sharedThread.id)}`,
        );
        return;
      }
      await set(catalog.ensureSelectedArtifactPreview$, artifactId, signal);
      signal.throwIfAborted();
      await set(refreshWorkspaceLayout$, signal);
      signal.throwIfAborted();
    },
  );

  return {
    open$: computed(async (get) => {
      return (
        (await get(featureSwitches$))[
          FeatureSwitchKey.ArtifactSidebarPreview
        ] && get(internalOpen$)
      );
    }),
    openArtifact$: command(
      async ({ set }, artifactId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const openSignal = set(resetOpenSignal$, signal);
        const trigger = document.activeElement;
        set(returnFocusTarget$, {
          artifactId,
          trigger:
            trigger instanceof HTMLElement &&
            trigger.dataset.artifactId === artifactId
              ? trigger
              : null,
        });
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
        await set(loadPreview$, artifactId, openSignal);
      },
    ),
    close$,
    cancelFocusRestore$: command(({ set }) => {
      set(returnFocusTarget$, null);
    }),
    restoreFocusRef$: onRef(
      command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
        signal.throwIfAborted();
        const target = get(returnFocusTarget$);
        if (!target || get(internalOpen$)) {
          return;
        }
        set(returnFocusTarget$, null);
        const trigger =
          target.trigger?.isConnected && element.contains(target.trigger)
            ? target.trigger
            : [...element.querySelectorAll<HTMLElement>("[data-artifact-id]")].find(
                (card) => card.dataset.artifactId === target.artifactId,
              );
        (trigger ?? element.querySelector<HTMLElement>("main"))?.focus({
          preventScroll: true,
        });
      }),
    ),
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
