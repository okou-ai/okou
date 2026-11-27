import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";

import { ArtifactCatalogPage } from "../../views/artifacts-page/artifact-catalog-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { artifactFavoritesEnabled$ } from "../artifact-favorites.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { artifactChangedTopic } from "@okouai/api-contracts/validators/realtime";
import { closeLightboxImmediately$ } from "../okou-page/attachment-chips.ts";
import { historyState$, searchParams$ } from "../route.ts";
import {
  artifactCatalogScrollTargetFromHistoryState,
  artifactIdFromCatalogSearchParams,
  cancelArtifactCatalogQuery$,
  initializeArtifactCatalogQueryFromRoute$,
  loadThroughArtifactCatalog$,
  openArtifact$,
  prepareArtifactCatalogPreviewHistory$,
  reloadArtifactCatalog$,
} from "./artifact-catalog-signals.ts";

import {
  artifactCatalogSidebar,
  artifactLibraryEnabled$,
} from "./artifact-catalog-instance.ts";

const onArtifactsChanged$ = command(async ({ set }, signal: AbortSignal) => {
  set(reloadArtifactCatalog$);
  await set(artifactCatalogSidebar.refreshPreviewSessions$, signal);
  return false;
});

export const setupArtifactsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(artifactCatalogSidebar.close$);
    signal.addEventListener(
      "abort",
      () => {
        set(artifactCatalogSidebar.close$);
        set(cancelArtifactCatalogQuery$);
      },
      { once: true },
    );
    const libraryEnabled = await get(artifactLibraryEnabled$);
    signal.throwIfAborted();
    const favoritesEnabled = await get(artifactFavoritesEnabled$);
    signal.throwIfAborted();
    const routeSearchParams = new URLSearchParams(get(searchParams$));
    const artifactId = artifactIdFromCatalogSearchParams(routeSearchParams);
    // Each visit installs its route-owned query and starts fresh paging.
    set(
      initializeArtifactCatalogQueryFromRoute$,
      routeSearchParams,
      libraryEnabled,
      favoritesEnabled,
      signal,
    );
    // A synced artifact shows its Google Drive state on its catalog row.
    set(
      setAblyLoop$,
      { topic: artifactChangedTopic, loopCommand$: onArtifactsChanged$ },
      signal,
    );
    if (artifactId) {
      set(prepareArtifactCatalogPreviewHistory$, artifactId, routeSearchParams);
    } else {
      set(closeLightboxImmediately$);
    }
    const scrollToArtifactId =
      artifactId ??
      artifactCatalogScrollTargetFromHistoryState(get(historyState$));
    set(
      updatePage$,
      createElement(ArtifactCatalogPage, { scrollToArtifactId }),
      "sidebar",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.artifacts.title;
      }),
    );
    await set(hideAppSkeleton$, signal);

    if (artifactId) {
      await set(openArtifact$, artifactId, signal);
    }
    if (scrollToArtifactId) {
      await set(loadThroughArtifactCatalog$, scrollToArtifactId, signal);
    }
  },
);
