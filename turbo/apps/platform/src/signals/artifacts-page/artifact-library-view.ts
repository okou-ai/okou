import { command, computed } from "ccstate";
import { animationFrame } from "signal-timers";

import { artifactCatalogViewport$ } from "../artifact-deletion.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";

export type ArtifactLibraryView = "grid" | "list";

const artifactLibraryViewStorage$ = computed(async (get) => {
  const sessionKey = get(authenticatedSessionKey$);
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;
  const userId = clerk.user?.id;
  if (
    !sessionKey ||
    !orgId ||
    !userId ||
    !clerk.session ||
    JSON.stringify([orgId, userId, clerk.session.id]) !== sessionKey
  ) {
    throw new DOMException("Artifact Library owner changed", "AbortError");
  }
  return {
    sessionKey,
    storage: localStorageSignals(`artifact-library-view:${orgId}:${userId}`),
  };
});

export const artifactLibraryView$ = computed(
  async (get): Promise<ArtifactLibraryView> => {
    const { storage } = await get(artifactLibraryViewStorage$);
    return get(storage.get$) === "list" ? "list" : "grid";
  },
);

export const setArtifactLibraryView$ = command(
  async (
    { get, set },
    view: ArtifactLibraryView,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const owner = await get(artifactLibraryViewStorage$);
    signal.throwIfAborted();
    if (get(authenticatedSessionKey$) !== owner.sessionKey) {
      throw new DOMException("Artifact Library owner changed", "AbortError");
    }
    const viewport = get(artifactCatalogViewport$);
    const scrollTop = viewport?.scrollTop ?? 0;
    set(owner.storage.set$, view);
    animationFrame(
      () => {
        if (viewport?.isConnected) {
          viewport.scrollTop = scrollTop;
        }
      },
      { signal },
    );
  },
);
