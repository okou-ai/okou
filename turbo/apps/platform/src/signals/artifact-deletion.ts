import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { toast } from "@okouai/ui/components/ui/sonner";

import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { onRef, resetSignal } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";

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
    await set(deleteOwnedArtifact$, target.id, signal);
    set(internalDeleteTarget$, null);
    set(internalDeletionCompleted$, true);
  },
);

const deleteOwnedArtifact$ = command(
  async ({ get, set }, artifactId: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(artifactCatalogContract).delete({
        params: { artifactId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.artifacts.deletion.success;
      }),
    );
    set(internalArtifactCatalogRevision$, (revision) => {
      return revision + 1;
    });
  },
);

function createPreviewArtifactDeletion(
  artifactId: string,
  surface: "dialog" | "sidebar",
) {
  const target$ = state<ArtifactSummary | null>(null);
  const trigger$ = state<HTMLElement | null>(null);
  const completed$ = state(false);
  // Thread artifacts can carry a resource ID rather than a catalog ID. The
  // owner-scoped detail read also hides management for foreign or deleted files.
  const detail$ = computed(async (get) => {
    get(artifactCatalogRevision$);
    const result = await accept(
      get(apiClient$)(artifactCatalogContract).get({
        params: { artifactId },
      }),
      [200, 403, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  return {
    artifactId,
    detail$,
    target$: computed((get) => {
      return get(target$);
    }),
    request$: command(
      async ({ get, set }, trigger: HTMLElement, signal: AbortSignal) => {
        const detail = await get(detail$);
        signal.throwIfAborted();
        if (detail) {
          set(trigger$, trigger);
          set(completed$, false);
          set(target$, detail);
        }
      },
    ),
    close$: command(({ set }) => {
      set(target$, null);
    }),
    finalFocus$: command(({ get }) => {
      // On success the preview itself closes. Let its outer dialog restore
      // chat focus; the catalog has a stable viewport after its card is removed.
      return get(completed$)
        ? (get(internalViewport$) ?? false)
        : get(trigger$);
    }),
    confirm$: command(
      async ({ get, set }, onDeleted: () => void, signal: AbortSignal) => {
        const target = get(target$);
        if (!target) {
          return;
        }
        await set(deleteOwnedArtifact$, target.id, signal);
        set(completed$, true);
        set(target$, null);
        onDeleted();
        const viewport = get(internalViewport$);
        if (surface === "sidebar" && viewport) {
          // Closing the sidebar unmounts its confirmation in the same commit.
          // Restore focus after that commit, when the catalog is no longer inert.
          animationFrame(
            () => {
              if (viewport.isConnected) {
                viewport.focus({ preventScroll: true });
              }
            },
            { signal },
          );
        }
      },
    ),
  };
}

function createPreviewDeletionScope(surface: "dialog" | "sidebar") {
  const identity$ = state<string | null>(null);
  const session$ = computed((get) => {
    const identity = get(identity$);
    return identity ? createPreviewArtifactDeletion(identity, surface) : null;
  });
  const resetMountSignal$ = resetSignal();
  const mountRef$ = onRef(
    command(
      ({ get, set }, element: HTMLSpanElement, mountSignal: AbortSignal) => {
        const artifactId = element.dataset.artifactId;
        if (!artifactId) {
          return;
        }
        const signal = set(resetMountSignal$, mountSignal, get(pageSignal$));
        set(identity$, artifactId);
        const session = get(session$)!;
        signal.addEventListener(
          "abort",
          () => {
            if (get(session$) === session) {
              set(identity$, null);
            }
          },
          { once: true },
        );
      },
    ),
  );
  return { session$, mountRef$ };
}

export type PreviewArtifactDeletion = ReturnType<
  typeof createPreviewArtifactDeletion
>;
// The two existing preview surfaces each own their mounted artifact; no URL cache.
const previewDeletionScopes = Object.freeze({
  dialog: createPreviewDeletionScope("dialog"),
  sidebar: createPreviewDeletionScope("sidebar"),
});
export function artifactPreviewDeletionScope(
  surface: keyof typeof previewDeletionScopes,
) {
  return previewDeletionScopes[surface];
}
