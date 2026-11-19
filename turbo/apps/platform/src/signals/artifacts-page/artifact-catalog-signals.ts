import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import {
  pageCatalog,
  artifactCatalogSidebar,
} from "./artifact-catalog-instance.ts";
import { artifactIdPathParamsSchema } from "@okouai/api-contracts/validators/artifact-catalog";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import { isTextPreviewKind } from "../text-preview.ts";
import {
  closeLightboxWithDialogExit$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  openFileLightbox$,
  openVideoLightbox$,
} from "../okou-page/attachment-chips.ts";
import {
  hash$,
  historyState$,
  pathname$,
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRef, resetSignal } from "../utils.ts";
import { artifactDetailPreview } from "./artifact-catalog-preview.ts";

export const selectedArtifactCatalogKind$ = pageCatalog.selectedKind$;

export const setArtifactCatalogKindFromRoute$ = pageCatalog.setKind$;

export function artifactCatalogKindFromSearchParams(
  params: URLSearchParams,
): ArtifactCatalogKind {
  const tab = params.get("tab");
  switch (tab) {
    case "file":
    case "hosted-site":
    case "image":
    case "video":
    case "avatar":
    case "shared-thread":
    case "presentation": {
      return tab;
    }
    default: {
      return "presentation";
    }
  }
}

export const setArtifactCatalogKind$ = command(
  ({ get, set }, kind: ArtifactCatalogKind | null) => {
    set(pageCatalog.setKind$, kind);
    const next = new URLSearchParams(get(searchParams$));
    if (!kind || kind === "presentation") {
      next.delete("tab");
    } else {
      next.set("tab", kind);
    }
    set(updateSearchParams$, next);
  },
);

export const reloadArtifactCatalog$ = pageCatalog.reload$;

export const artifactCatalog$ = pageCatalog.catalog$;

export const loadMoreArtifactCatalog$ = pageCatalog.loadMore$;

export const loadThroughArtifactCatalog$ = pageCatalog.loadThroughArtifact$;

export const scrollArtifactCardIntoViewRef$ = onRef(
  command((_context, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    element.scrollIntoView({ block: "center" });
  }),
);

export function artifactIdFromCatalogSearchParams(
  params: URLSearchParams,
): string | null {
  const artifactId = params.get("artifact");
  const parsed = artifactIdPathParamsSchema.safeParse({
    artifactId,
  });
  return parsed.success ? artifactId : null;
}

export function artifactCatalogScrollTargetFromHistoryState(
  historyState: unknown,
): string | null {
  if (
    typeof historyState !== "object" ||
    historyState === null ||
    !("artifactCatalogScrollId" in historyState)
  ) {
    return null;
  }
  const artifactId = historyState.artifactCatalogScrollId;
  return typeof artifactId === "string" ? artifactId : null;
}

export const closeArtifactCatalogPreview$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(artifactCatalogSidebar.close$);
    set(closeLightboxWithDialogExit$, signal);
    if (get(pathname$) !== ROUTES.artifacts) {
      return;
    }
    const searchParams = new URLSearchParams(get(searchParams$));
    const artifactId = artifactIdFromCatalogSearchParams(searchParams);
    if (artifactId === null) {
      return;
    }
    searchParams.delete("artifact");
    const historyState = get(historyState$);
    set(
      replaceSearchParams$,
      searchParams,
      {
        ...(typeof historyState === "object" && historyState !== null
          ? historyState
          : {}),
        artifactCatalogScrollId: artifactId,
      },
      get(hash$),
    );
  },
);

/**
 * Open a card. The kind entity is fetched here rather than with the list, so
 * browsing the grid never pays for detail queries.
 */
const resetOpenArtifactSignal$ = resetSignal();

export const openArtifact$ = command(
  async ({ get, set }, artifactId: string, signal: AbortSignal) => {
    if (
      (await get(featureSwitches$))[FeatureSwitchKey.ArtifactSidebarPreview]
    ) {
      await set(artifactCatalogSidebar.openArtifact$, artifactId, signal);
      return;
    }
    const openSignal = set(resetOpenArtifactSignal$, signal);
    set(pageCatalog.selectArtifact$, artifactId);
    const detail = await get(pageCatalog.selectedArtifactDetail$);
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

    const preview = artifactDetailPreview(detail);
    const previewSignals = await set(
      pageCatalog.ensureSelectedArtifactPreview$,
      artifactId,
      openSignal,
    );
    signal.throwIfAborted();
    openSignal.throwIfAborted();
    if (!previewSignals) {
      return;
    }
    const base = {
      catalogArtifactId: detail.id,
      filename: preview.filename,
      contentType: preview.contentType,
      artifactKind: preview.artifactKind,
      preview: previewSignals,
      showSizeInSubtitle: false,
      splitViewAvailable: false,
      url: preview.url,
    };
    if (preview.kind === "file") {
      await set(openFileLightbox$, base, undefined, signal);
      return;
    }
    if (preview.kind === "image") {
      await set(openImageLightbox$, base, undefined, signal);
      return;
    }
    if (preview.kind === "video") {
      await set(openVideoLightbox$, base, undefined, signal);
      return;
    }
    if (preview.kind === "audio") {
      await set(openAudioLightbox$, base, undefined, signal);
      return;
    }
    if (isTextPreviewKind(preview.kind)) {
      await set(
        openDocumentLightbox$,
        {
          ...base,
          kind: preview.kind,
        },
        undefined,
        signal,
      );
      return;
    }
    await set(
      openDocumentLightbox$,
      { ...base, kind: preview.kind },
      undefined,
      signal,
    );
  },
);
