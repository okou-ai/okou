import { command } from "ccstate";
import {
  artifactCatalogContract,
  type ArtifactCatalogKind,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { downloadAttachment$ } from "../attachment-download.ts";
import { isTextPreviewKind } from "../text-preview.ts";
import {
  closeLightboxWithDialogExit$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  openVideoLightbox$,
} from "../okou-page/attachment-chips.ts";
import {
  historyState$,
  pathname$,
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRef, resetSignal } from "../utils.ts";
import { artifactDetailPreview } from "./artifact-catalog-preview.ts";
import { createArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

/**
 * The `/artifacts` page instance over the whole org catalog. Chat thread
 * sidebars create their own thread-scoped instances.
 */
const pageCatalog = createArtifactCatalogSignals();

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

const ARTIFACT_PREVIEW_HISTORY_STATE_KEY = "artifactCatalogPreviewId";
const ARTIFACT_SCROLL_HISTORY_STATE_KEY = "artifactCatalogScrollId";

function artifactIdFromHistoryState(
  state: unknown,
  key:
    | typeof ARTIFACT_PREVIEW_HISTORY_STATE_KEY
    | typeof ARTIFACT_SCROLL_HISTORY_STATE_KEY,
): string | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const value =
    key === ARTIFACT_PREVIEW_HISTORY_STATE_KEY &&
    ARTIFACT_PREVIEW_HISTORY_STATE_KEY in state
      ? state.artifactCatalogPreviewId
      : key === ARTIFACT_SCROLL_HISTORY_STATE_KEY &&
          ARTIFACT_SCROLL_HISTORY_STATE_KEY in state
        ? state.artifactCatalogScrollId
        : null;
  return typeof value === "string" ? value : null;
}

export function artifactIdFromCatalogSearchParams(
  params: URLSearchParams,
): string | null {
  const artifactId = params.get("artifact");
  const parsed = artifactCatalogContract.get.pathParams.safeParse({
    artifactId,
  });
  return parsed.success ? artifactId : null;
}

export function artifactCatalogScrollTargetFromHistoryState(
  historyState: unknown,
): string | null {
  return artifactIdFromHistoryState(
    historyState,
    ARTIFACT_SCROLL_HISTORY_STATE_KEY,
  );
}

/**
 * Give a routed preview its own entry above the catalog. Browser Back can then
 * close the preview while leaving the user on the matching artifact tab.
 */
export const prepareArtifactCatalogPreviewHistory$ = command(
  ({ get, set }, artifactId: string, previewSearchParams: URLSearchParams) => {
    if (
      artifactIdFromHistoryState(
        get(historyState$),
        ARTIFACT_PREVIEW_HISTORY_STATE_KEY,
      ) === artifactId
    ) {
      return;
    }
    const catalogSearchParams = new URLSearchParams(previewSearchParams);
    catalogSearchParams.delete("artifact");
    set(replaceSearchParams$, catalogSearchParams, {
      [ARTIFACT_SCROLL_HISTORY_STATE_KEY]: artifactId,
    });
    set(updateSearchParams$, previewSearchParams, {
      [ARTIFACT_PREVIEW_HISTORY_STATE_KEY]: artifactId,
      [ARTIFACT_SCROLL_HISTORY_STATE_KEY]: artifactId,
    });
  },
);

export const closeArtifactCatalogPreview$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const artifactId = artifactIdFromCatalogSearchParams(get(searchParams$));
    const previewArtifactId = artifactIdFromHistoryState(
      get(historyState$),
      ARTIFACT_PREVIEW_HISTORY_STATE_KEY,
    );
    if (
      get(pathname$) === ROUTES.artifacts &&
      artifactId !== null &&
      artifactId === previewArtifactId
    ) {
      window.history.back();
      return;
    }
    set(closeLightboxWithDialogExit$, signal);
  },
);

/**
 * Open a card. The kind entity is fetched here rather than with the list, so
 * browsing the grid never pays for detail queries.
 */
const resetOpenArtifactSignal$ = resetSignal();

export const openArtifact$ = command(
  async ({ get, set }, artifactId: string, signal: AbortSignal) => {
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
    if (preview.kind === "file") {
      await set(
        downloadAttachment$,
        { filename: preview.filename, url: preview.url },
        openSignal,
      );
      signal.throwIfAborted();
      openSignal.throwIfAborted();
      return;
    }
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
      filename: preview.filename,
      preview: previewSignals,
      showSizeInSubtitle: false,
      splitViewAvailable: false,
      url: preview.url,
    };
    if (preview.kind === "image") {
      set(openImageLightbox$, base);
      return;
    }
    if (preview.kind === "video") {
      set(openVideoLightbox$, base);
      return;
    }
    if (preview.kind === "audio") {
      set(openAudioLightbox$, base);
      return;
    }
    if (isTextPreviewKind(preview.kind)) {
      set(openDocumentLightbox$, {
        ...base,
        kind: preview.kind,
      });
      return;
    }
    set(openDocumentLightbox$, { ...base, kind: preview.kind });
  },
);
