import { command, computed, state } from "ccstate";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRef } from "../utils.ts";

const internalArtifactCatalogRevision$ = state(0);
export const artifactCatalogRevision$ = computed((get) => {
  return get(internalArtifactCatalogRevision$);
});
const internalDeleteTarget$ = state<ArtifactSummary | null>(null);
const internalReturnFocus$ = state<HTMLElement | null>(null);
const internalViewport$ = state<HTMLElement | null>(null);
const internalDeletionCompleted$ = state(false);
export const artifactDeleteTarget$ = computed((get) => {
  return get(internalDeleteTarget$);
});
export const setArtifactDeleteTarget$ = command(
  ({ set }, artifact: ArtifactSummary | null) => {
    set(internalDeleteTarget$, artifact);
    set(internalDeletionCompleted$, false);
  },
);

export const artifactCatalogViewportRef$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    set(internalViewport$, element);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalViewport$) === element) {
          set(internalViewport$, null);
        }
      },
      { once: true },
    );
  }),
);

// The menu item disappears when it opens the dialog. Cancellation returns to
// the persistent card trigger; deletion returns to the remaining catalog.
export const artifactDeletionFinalFocus$ = command(({ get }) => {
  return get(internalDeletionCompleted$)
    ? get(internalViewport$)
    : get(internalReturnFocus$);
});

export function createArtifactDeleteMenuSignals(artifact: ArtifactSummary) {
  const internalTrigger$ = state<HTMLElement | null>(null);
  return {
    triggerRef$: onRef(
      command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
        set(internalTrigger$, element);
        signal.addEventListener(
          "abort",
          () => {
            set(internalTrigger$, null);
            if (get(internalReturnFocus$) === element) {
              set(internalReturnFocus$, null);
            }
          },
          { once: true },
        );
      }),
    ),
    request$: command(({ get, set }) => {
      set(setArtifactDeleteTarget$, artifact);
      set(internalReturnFocus$, get(internalTrigger$));
    }),
  };
}

export const deleteCatalogArtifact$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const target = get(internalDeleteTarget$);
    if (!target) {
      return;
    }
    await accept(
      get(apiClient$)(artifactCatalogContract).delete({
        params: { artifactId: target.id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(internalArtifactCatalogRevision$, (revision) => {
      return revision + 1;
    });
    set(internalDeleteTarget$, null);
    set(internalDeletionCompleted$, true);
  },
);
