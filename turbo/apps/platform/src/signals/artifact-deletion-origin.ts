import { command } from "ccstate";
import { artifactPreviewDeletionScope } from "./artifact-deletion.ts";
import { closeArtifactCatalogPreview$ } from "./artifacts-page/artifact-catalog-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-page/chat-thread-pane-state.ts";
import { closeDeletedThreadArtifact$ } from "./chat-page/thread-sidebar-coordinator.ts";
import { rootSignal$ } from "./root-signal.ts";
import { detachedNavigateTo$ } from "./route.ts";

/**
 * The preview surface an artifact is deleted from. The deletion command
 * derives the surface's own completion from it, so a view describes where it
 * is instead of passing what happens after the deletion.
 */
export type ArtifactDeletionOrigin =
  /** The standalone artifact page, which returns to the catalog. */
  | { readonly kind: "artifact-page" }
  /** The preview dialog over the catalog or a chat. */
  | { readonly kind: "preview-dialog" }
  /** The artifacts page sidebar. */
  | { readonly kind: "catalog-sidebar" }
  /** The sidebar of the chat thread with this id. */
  | { readonly kind: "thread-sidebar"; readonly threadId: string };

export function artifactDeletionSurface(
  origin: ArtifactDeletionOrigin,
): "dialog" | "sidebar" | "page" {
  switch (origin.kind) {
    case "artifact-page": {
      return "page";
    }
    case "preview-dialog": {
      return "dialog";
    }
    case "catalog-sidebar":
    case "thread-sidebar": {
      return "sidebar";
    }
  }
}

/** Leaves the surface whose artifact was just deleted. */
const leaveDeletedArtifactSurface$ = command(
  ({ get, set }, origin: ArtifactDeletionOrigin, signal: AbortSignal): void => {
    switch (origin.kind) {
      case "artifact-page": {
        set(detachedNavigateTo$, "/artifacts");
        return;
      }
      case "preview-dialog": {
        // The preview may belong to a chat that outlives this page.
        set(closeArtifactCatalogPreview$, get(rootSignal$));
        return;
      }
      case "catalog-sidebar": {
        set(closeArtifactCatalogPreview$, signal);
        return;
      }
      case "thread-sidebar": {
        const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
          (candidate) => {
            return candidate?.threadId === origin.threadId;
          },
        );
        if (thread) {
          set(closeDeletedThreadArtifact$, thread, signal);
        }
        return;
      }
    }
  },
);

/** Deletes the surface's pending artifact, then leaves that surface. */
export const confirmArtifactDeletion$ = command(
  async (
    { get, set },
    origin: ArtifactDeletionOrigin,
    signal: AbortSignal,
  ): Promise<void> => {
    const session = get(
      artifactPreviewDeletionScope(artifactDeletionSurface(origin)).session$,
    );
    if (!session) {
      return;
    }
    await set(
      session.confirm$,
      () => {
        set(leaveDeletedArtifactSurface$, origin, signal);
      },
      signal,
    );
  },
);
