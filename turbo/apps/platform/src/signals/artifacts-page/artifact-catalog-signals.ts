import { command, state } from "ccstate";
import { animationFrame } from "signal-timers";
import {
  pageCatalog,
  artifactCatalogSidebar,
} from "./artifact-catalog-instance.ts";
import { artifactIdPathParamsSchema } from "@okouai/api-contracts/validators/artifact-catalog";
import type {
  ArtifactCatalogCategory,
  ArtifactCatalogDirection,
  ArtifactCatalogKind,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  historyState$,
  pathname$,
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRef } from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";
import { artifactCatalogViewport$ } from "../artifact-deletion.ts";

// Route defaults and serialization follow the mode installed by page setup.
// Requests independently read the authoritative feature switch.
const routeLibraryMode$ = state(false);
const internalPreviewTrigger$ = state<HTMLElement | null>(null);

export const selectedArtifactCatalogKind$ = pageCatalog.selectedKind$;
export const selectedArtifactCatalogCategory$ = pageCatalog.selectedCategory$;

function artifactCatalogCategoryFromSearchParams(
  params: URLSearchParams,
): ArtifactCatalogCategory | null {
  const category = params.get("category");
  switch (category) {
    case "document":
    case "presentation":
    case "website":
    case "spreadsheet":
    case "image":
    case "video":
    case "audio":
    case "other": {
      return category;
    }
    default: {
      return null;
    }
  }
}

export function artifactCatalogKindFromSearchParams(
  params: URLSearchParams,
  libraryEnabled = false,
): ArtifactCatalogKind | null {
  const tab = params.get("tab");
  switch (tab) {
    case "file":
    case "hosted-site":
    case "image":
    case "avatar":
    case "shared-thread":
    case "presentation": {
      return tab;
    }
    default: {
      return libraryEnabled ? null : "presentation";
    }
  }
}

export const initializeArtifactCatalogQueryFromRoute$ = command(
  (
    { set },
    params: URLSearchParams,
    libraryEnabled: boolean,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(routeLibraryMode$, libraryEnabled);
    set(internalPreviewTrigger$, null);
    const category = libraryEnabled
      ? artifactCatalogCategoryFromSearchParams(params)
      : null;
    set(
      pageCatalog.initializeQuery$,
      {
        category,
        kind: category
          ? null
          : artifactCatalogKindFromSearchParams(params, libraryEnabled),
        search: libraryEnabled ? (params.get("q") ?? "") : "",
        direction: params.get("direction") === "asc" ? "asc" : "desc",
      },
      signal,
    );
  },
);

const writeArtifactCatalogQueryToRoute$ = command(
  ({ get, set }, replace: boolean) => {
    const next = new URLSearchParams(get(searchParams$));
    const kind = get(pageCatalog.selectedKind$);
    if (get(routeLibraryMode$)) {
      const category = get(pageCatalog.selectedCategory$);
      if (category) {
        next.set("category", category);
        next.delete("tab");
      } else {
        next.delete("category");
        next.set("tab", kind ?? "all");
      }
      const search = get(pageCatalog.search$);
      if (search) {
        next.set("q", search);
      } else {
        next.delete("q");
      }
      next.set("direction", get(pageCatalog.direction$));
    } else if (!kind || kind === "presentation") {
      next.delete("tab");
    } else {
      next.set("tab", kind);
    }
    if (next.toString() === get(searchParams$).toString()) {
      return;
    }
    const historyState = get(historyState$);
    const artifactId = artifactIdFromCatalogSearchParams(next);
    if (
      get(routeLibraryMode$) &&
      artifactId !== null &&
      artifactId ===
        artifactIdFromHistoryState(
          historyState,
          ARTIFACT_PREVIEW_HISTORY_STATE_KEY,
        )
    ) {
      // The edited query now owns this entry; keep the live preview off-route.
      next.delete("artifact");
      const catalogHistoryState: Record<string, unknown> =
        typeof historyState === "object" && historyState !== null
          ? { ...historyState }
          : {};
      delete catalogHistoryState[ARTIFACT_PREVIEW_HISTORY_STATE_KEY];
      set(replaceSearchParams$, next, catalogHistoryState);
      return;
    }
    set(
      replace ? replaceSearchParams$ : updateSearchParams$,
      next,
      historyState,
    );
  },
);

export const setArtifactCatalogKind$ = command(
  ({ set }, kind: ArtifactCatalogKind | null) => {
    set(pageCatalog.setKind$, kind);
    set(writeArtifactCatalogQueryToRoute$, false);
  },
);

export const setArtifactCatalogCategory$ = command(
  ({ set }, category: ArtifactCatalogCategory | null) => {
    set(pageCatalog.setCategory$, category);
    set(writeArtifactCatalogQueryToRoute$, false);
  },
);

export const artifactCatalogSearch$ = pageCatalog.search$;

export const setArtifactCatalogSearch$ = command(
  async ({ set }, search: string, signal: AbortSignal): Promise<void> => {
    const update = set(pageCatalog.setSearch$, search, signal);
    set(writeArtifactCatalogQueryToRoute$, true);
    await update;
    signal.throwIfAborted();
  },
);

export const artifactCatalogDirection$ = pageCatalog.direction$;

export const setArtifactCatalogDirection$ = command(
  ({ set }, direction: ArtifactCatalogDirection) => {
    set(pageCatalog.setDirection$, direction);
    set(writeArtifactCatalogQueryToRoute$, false);
  },
);

export const cancelArtifactCatalogQuery$ = command(({ set }) => {
  set(internalPreviewTrigger$, null);
  set(routeLibraryMode$, false);
  set(pageCatalog.cancelQuery$);
});

export const rememberArtifactCatalogTrigger$ = command(
  ({ get, set }, trigger: HTMLElement) => {
    if (get(routeLibraryMode$)) {
      set(internalPreviewTrigger$, trigger);
    }
  },
);

export const reloadArtifactCatalog$ = pageCatalog.reload$;

export const artifactCatalog$ = pageCatalog.catalog$;

export const artifactCatalogPagingState$ = pageCatalog.pagingState$;

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
  const parsed = artifactIdPathParamsSchema.safeParse({
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

export const closeArtifactCatalogPreview$ = command(({ get, set }) => {
  const previewTrigger = get(internalPreviewTrigger$);
  set(internalPreviewTrigger$, null);
  set(artifactCatalogSidebar.close$);
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
  if (get(routeLibraryMode$)) {
    const viewport = get(artifactCatalogViewport$);
    animationFrame(
      () => {
        if (get(artifactCatalogSidebar.open$)) {
          return;
        }
        const target = previewTrigger?.isConnected
          ? previewTrigger
          : viewport?.isConnected
            ? viewport
            : null;
        target?.focus({ preventScroll: true });
      },
      { signal: get(pageSignal$) },
    );
  }
});

export const openArtifact$ = artifactCatalogSidebar.openArtifact$;
