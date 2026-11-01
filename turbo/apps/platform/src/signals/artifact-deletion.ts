import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { toast } from "@okouai/ui/components/ui/sonner";

import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { onRef, resetSignal } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";
import { authenticatedSessionKey$ } from "./auth.ts";

export type ArtifactDeletionSourceKind = "shared-thread" | "reference";

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
  surface: "dialog" | "sidebar" | "page",
  sourceKind?: ArtifactDeletionSourceKind,
) {
  const target$ = state<ArtifactSummary | null>(null);
  const trigger$ = state<HTMLElement | null>(null);
  const completed$ = state(false);
  // Shared pages carry source resource IDs. Only an owner-scoped catalog read
  // can resolve the identity accepted by deletion, including for public links.
  const detail$ = computed(async (get) => {
    get(artifactCatalogRevision$);
    // A token refresh must not reload the action and unmount its focus target.
    if (surface === "page" && !get(authenticatedSessionKey$)) {
      return null;
    }
    let catalogId = artifactId;
    if (sourceKind === "reference") {
      const owner = await accept(
        get(apiClient$)(artifactReferencesContract).ownerArtifact({
          params: { reference: artifactId },
          fetchOptions: { cache: "no-store" },
        }),
        [200, 401, 403, 404],
      );
      if (owner.status !== 200) {
        return null;
      }
      catalogId = owner.body.artifactId;
    }
    const result = await accept(
      get(apiClient$)(artifactCatalogContract).get({
        params: { artifactId: catalogId },
        ...(sourceKind && sourceKind !== "reference"
          ? { query: { sourceKind } }
          : {}),
        fetchOptions: { cache: "no-store" },
      }),
      [200, 401, 403, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  return {
    artifactId,
    sourceKind,
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
      if (!get(completed$)) {
        return get(trigger$);
      }
      // On success the preview itself closes. Let its outer dialog restore
      // chat focus, or let the standalone page's destination own focus. The
      // catalog has a stable viewport after its card is removed.
      return surface === "page" ? false : (get(internalViewport$) ?? false);
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

function createPreviewDeletionScope(surface: "dialog" | "sidebar" | "page") {
  const menuTrigger$ = state<HTMLElement | null>(null);
  const menuTriggerRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(menuTrigger$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(menuTrigger$) === element) {
            set(menuTrigger$, null);
          }
        },
        { once: true },
      );
    }),
  );
  const identity$ = state<{
    readonly artifactId: string;
    readonly sourceKind?: ArtifactDeletionSourceKind;
  } | null>(null);
  const session$ = computed((get) => {
    const identity = get(identity$);
    return identity
      ? createPreviewArtifactDeletion(
          identity.artifactId,
          surface,
          identity.sourceKind,
        )
      : null;
  });
  const resetMountSignal$ = resetSignal();
  const mountRef$ = onRef(
    command(
      ({ get, set }, element: HTMLSpanElement, mountSignal: AbortSignal) => {
        const artifactId = element.dataset.artifactId;
        if (!artifactId) {
          return;
        }
        const sourceKind = element.dataset.sourceKind;
        if (
          sourceKind !== undefined &&
          sourceKind !== "reference" &&
          sourceKind !== "shared-thread"
        ) {
          return;
        }
        const signal = set(resetMountSignal$, mountSignal, get(pageSignal$));
        set(identity$, { artifactId, sourceKind });
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
  return {
    session$,
    detail$: computed(async (get) => {
      const session = get(session$);
      return session ? await get(session.detail$) : null;
    }),
    mountRef$,
    menuTriggerRef$,
    menuTrigger$: computed((get) => {
      return get(menuTrigger$);
    }),
  };
}

export type PreviewArtifactDeletion = ReturnType<
  typeof createPreviewArtifactDeletion
>;
// Each preview surface owns its mounted artifact; no URL cache.
const previewDeletionScopes = Object.freeze({
  dialog: createPreviewDeletionScope("dialog"),
  sidebar: createPreviewDeletionScope("sidebar"),
  page: createPreviewDeletionScope("page"),
});
export function artifactPreviewDeletionScope(
  surface: keyof typeof previewDeletionScopes,
) {
  return previewDeletionScopes[surface];
}
