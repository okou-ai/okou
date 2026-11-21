import { command, state } from "ccstate";
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
  closeLightboxImmediatelyForOwner$,
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

const internalArtifactCatalogScrollTarget$ = state<string | null>(null);

export const prepareArtifactCatalogScroll$ = command(
  ({ set }, artifactId: string | null) => {
    set(internalArtifactCatalogScrollTarget$, artifactId);
  },
);

export const scrollArtifactCardIntoViewRef$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      get(internalArtifactCatalogScrollTarget$) !== element.dataset.artifactId
    ) {
      return;
    }
    set(internalArtifactCatalogScrollTarget$, null);
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

const resetOpenArtifactSignal$ = resetSignal();

const replaceArtifactCatalogSelection$ = command(
  ({ get, set }, artifactId: string | null) => {
    if (get(pathname$) !== ROUTES.artifacts) {
      return;
    }
    const searchParams = new URLSearchParams(get(searchParams$));
    const previousArtifactId = artifactIdFromCatalogSearchParams(searchParams);
    if (artifactId === null && !searchParams.has("artifact")) {
      return;
    }
    if (artifactId === null) {
      searchParams.delete("artifact");
    } else {
      searchParams.set("artifact", artifactId);
    }
    const historyState = get(historyState$);
    set(
      replaceSearchParams$,
      searchParams,
      {
        ...(typeof historyState === "object" && historyState !== null
          ? historyState
          : {}),
        artifactCatalogScrollId: artifactId ?? previousArtifactId,
      },
      get(hash$),
    );
  },
);

export const disposeArtifactCatalogPreview$ = command(({ set }) => {
  set(resetOpenArtifactSignal$);
  set(internalArtifactCatalogScrollTarget$, null);
  set(artifactCatalogSidebar.close$);
  set(closeLightboxImmediatelyForOwner$, closeArtifactCatalogPreview$);
});

export const closeArtifactCatalogPreview$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(resetOpenArtifactSignal$);
    set(internalArtifactCatalogScrollTarget$, null);
    set(replaceArtifactCatalogSelection$, null);
    set(artifactCatalogSidebar.close$, true);
    set(closeLightboxWithDialogExit$, signal);
  },
);

const loadArtifactPreview$ = command(
  async ({ get, set }, artifactId: string, signal: AbortSignal) => {
    const features = await get(featureSwitches$);
    signal.throwIfAborted();
    if (features[FeatureSwitchKey.ArtifactSidebarPreview]) {
      await set(artifactCatalogSidebar.openArtifact$, artifactId, signal);
      return;
    }
    const detail = await get(pageCatalog.selectedArtifactDetail$);
    signal.throwIfAborted();
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
      signal,
    );
    signal.throwIfAborted();
    if (!previewSignals) {
      return;
    }
    const base = {
      catalogArtifactId: detail.id,
      dismiss$: closeArtifactCatalogPreview$,
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

/** Select without adding a browser visit; only route entry locates the card. */
const openArtifactSelection$ = command(
  async (
    { set },
    artifactId: string,
    locateCard: boolean,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const openSignal = set(resetOpenArtifactSignal$, signal);
    if (!locateCard) {
      set(internalArtifactCatalogScrollTarget$, null);
    }
    set(artifactCatalogSidebar.cancelFocusRestore$);
    set(pageCatalog.selectArtifact$, artifactId);
    set(replaceArtifactCatalogSelection$, artifactId);
    const [result] = await Promise.allSettled([
      set(loadArtifactSelection$, artifactId, locateCard, openSignal),
    ]);
    signal.throwIfAborted();
    if (
      result.status === "rejected" &&
      (!openSignal.aborted || result.reason !== openSignal.reason)
    ) {
      throw result.reason;
    }
  },
);

const loadArtifactSelection$ = command(
  async (
    { set },
    artifactId: string,
    locateCard: boolean,
    signal: AbortSignal,
  ) => {
    await set(loadArtifactPreview$, artifactId, signal);
    signal.throwIfAborted();
    if (locateCard) {
      await set(loadThroughArtifactCatalog$, artifactId, signal);
    }
  },
);

export const openArtifact$ = command(
  ({ set }, artifactId: string, signal: AbortSignal) => {
    return set(openArtifactSelection$, artifactId, false, signal);
  },
);

export const openArtifactFromRoute$ = command(
  ({ set }, artifactId: string, signal: AbortSignal) => {
    return set(openArtifactSelection$, artifactId, true, signal);
  },
);
