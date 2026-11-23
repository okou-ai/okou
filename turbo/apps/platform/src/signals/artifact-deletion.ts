import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { toast } from "@okouai/ui/components/ui/sonner";

import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { onRef, resetSignal } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
export type ArtifactDeletionSourceKind = "shared-thread" | "reference";

const internalArtifactCatalogRevision$ = state(0);
export const artifactCatalogRevision$ = computed((get) => {
  return get(internalArtifactCatalogRevision$);
});
const internalViewport$ = state<HTMLElement | null>(null);
export const artifactCatalogViewport$ = computed((get) => {
  return get(internalViewport$);
});

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

export function createArtifactDeletionSession(
  artifactId: string,
  surface: "dialog" | "sidebar" | "page" | "catalog-row",
  sourceKind?: ArtifactDeletionSourceKind,
) {
  const detailRequest$ = state<
    ((createClient: ApiClientFactory) => Promise<ArtifactSummary | null>) | null
  >(null);
  const target$ = state<ArtifactSummary | null>(null);
  const trigger$ = state<HTMLElement | null>(null);
  const completed$ = state(false);
  // Shared pages carry source resource IDs. Only an owner-scoped catalog read
  // can resolve the identity accepted by deletion, including for public links.
  const detail$ = computed(async (get) => {
    const request = get(detailRequest$);
    if (!request) {
      return null;
    }
    if (surface !== "catalog-row") {
      get(artifactCatalogRevision$);
    }
    // A token refresh must not reload the action and unmount its focus target.
    if (surface === "page" && !get(authenticatedSessionKey$)) {
      return null;
    }
    return await request(get(apiClient$));
  });
  return {
    artifactId,
    sourceKind,
    detail$,
    initialize$: command(({ set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(detailRequest$, () => {
        return async (createClient: ApiClientFactory) => {
          signal.throwIfAborted();
          let catalogId = artifactId;
          if (sourceKind === "reference") {
            const owner = await accept(
              createClient(artifactReferencesContract).ownerArtifact({
                params: { reference: artifactId },
                fetchOptions: { cache: "no-store", signal },
              }),
              [200, 401, 403, 404],
              signal,
            );
            signal.throwIfAborted();
            if (owner.status !== 200) {
              return null;
            }
            catalogId = owner.body.artifactId;
          }
          const result = await accept(
            createClient(artifactCatalogContract).get({
              params: { artifactId: catalogId },
              ...(sourceKind && sourceKind !== "reference"
                ? { query: { sourceKind } }
                : {}),
              fetchOptions: { cache: "no-store", signal },
            }),
            [200, 401, 403, 404],
            signal,
          );
          signal.throwIfAborted();
          return result.status === 200 ? result.body : null;
        };
      });
    }),
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
        const trigger = get(trigger$);
        return trigger?.isConnected
          ? trigger
          : (get(internalViewport$) ?? false);
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
        // Submission belongs to the page, not a transient row or menu mount.
        await set(deleteOwnedArtifact$, target.id, signal);
        signal.throwIfAborted();
        set(completed$, true);
        set(target$, null);
        onDeleted();
        const viewport = get(internalViewport$);
        if ((surface === "sidebar" || surface === "catalog-row") && viewport) {
          // Removing the row or closing the sidebar can unmount its dialog.
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
  const menuTrigger$ = state<HTMLButtonElement | null>(null);
  const menuTriggerRef$ = onRef(
    command(({ get, set }, element: HTMLButtonElement, signal: AbortSignal) => {
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
      ? createArtifactDeletionSession(
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
        set(session.initialize$, signal);
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
  const requestFromMenu$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const session = get(session$);
      const trigger = get(menuTrigger$);
      if (session && trigger) {
        // The menu item unmounts on selection; return to the persistent trigger.
        await set(session.request$, trigger, signal);
      }
    },
  );
  return {
    session$,
    mountRef$,
    menuTriggerRef$,
    requestFromMenu$,
  };
}

export type ArtifactDeletionSession = ReturnType<
  typeof createArtifactDeletionSession
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
