import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";

import { ArtifactCatalogPage } from "../../views/artifacts-page/artifact-catalog-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { closeLightboxImmediately$ } from "../okou-page/attachment-chips.ts";
import { historyState$, searchParams$ } from "../route.ts";
import {
  artifactCatalogSidebar,
  artifactCatalogKindFromSearchParams,
  artifactCatalogScrollTargetFromHistoryState,
  artifactIdFromCatalogSearchParams,
  loadThroughArtifactCatalog$,
  openArtifact$,
  prepareArtifactCatalogPreviewHistory$,
  reloadArtifactCatalog$,
  setArtifactCatalogKindFromRoute$,
} from "./artifact-catalog-signals.ts";

export const setupArtifactsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(artifactCatalogSidebar.close$);
    signal.addEventListener(
      "abort",
      () => {
        set(artifactCatalogSidebar.close$);
      },
      { once: true },
    );
    const routeSearchParams = new URLSearchParams(get(searchParams$));
    const artifactId = artifactIdFromCatalogSearchParams(routeSearchParams);
    const kind = artifactCatalogKindFromSearchParams(routeSearchParams);
    // Entering the page always starts a fresh first page. Later pages are
    // fetched on scroll and never cached across visits.
    set(setArtifactCatalogKindFromRoute$, kind);
    set(reloadArtifactCatalog$);
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
