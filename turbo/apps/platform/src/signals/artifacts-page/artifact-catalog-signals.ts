import { command, state } from "ccstate";
import { animationFrame } from "signal-timers";
import {
  pageCatalog,
  artifactCatalogSidebar,
} from "./artifact-catalog-instance.ts";
import { artifactIdPathParamsSchema } from "@okouai/api-contracts/validators/artifact-catalog";
import type {
  ArtifactCatalogDirection,
  ArtifactCatalogKind,
  ArtifactCatalogSort,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ArtifactCatalogOrder } from "./create-artifact-catalog-signals.ts";
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
import { authenticatedSessionKey$ } from "../auth.ts";

// Route defaults and serialization follow the mode installed by page setup.
// Requests independently read the authoritative feature switch.
const routeLibraryMode$ = state(false);
const internalPreviewTrigger$ = state<HTMLElement | null>(null);
const internalScrolledArtifactId$ = state<string | null>(null);

export const selectedArtifactCatalogKind$ = pageCatalog.selectedKind$;

export function artifactCatalogKindFromSearchParams(
  params: URLSearchParams,
  libraryEnabled = false,
): ArtifactCatalogKind | null {
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
      return libraryEnabled ? null : "presentation";
    }
  }
}

function artifactCatalogSortFromSearchParams(
  params: URLSearchParams,
): ArtifactCatalogOrder {
  const sort = params.get("sort");
  if (sort !== "createdAt" && sort !== "title") {
    return { sort: "createdAt", direction: "desc" };
  }
  return {
    sort,
    direction: params.get("direction") === "asc" ? "asc" : "desc",
  };
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
    set(internalScrolledArtifactId$, null);
    set(
      pageCatalog.initializeQuery$,
      {
        kind: artifactCatalogKindFromSearchParams(params, libraryEnabled),
        search: libraryEnabled ? (params.get("q") ?? "") : "",
        starredOnly: libraryEnabled && params.get("starred") === "true",
        ...artifactCatalogSortFromSearchParams(params),
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
      next.set("tab", kind ?? "all");
      const search = get(pageCatalog.search$);
      if (search) {
        next.set("q", search);
      } else {
        next.delete("q");
      }
      const order = get(pageCatalog.sort$);
      next.set("sort", order.sort);
      next.set("direction", order.direction);
      if (get(pageCatalog.starredOnly$)) {
        next.set("starred", "true");
      } else {
        next.delete("starred");
      }
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

export const artifactCatalogStarredOnly$ = pageCatalog.starredOnly$;

export const setArtifactCatalogStarredOnly$ = command(
  ({ set }, starredOnly: boolean) => {
    set(pageCatalog.setStarredOnly$, starredOnly);
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

export const artifactCatalogSort$ = pageCatalog.sort$;

export const setArtifactCatalogSort$ = command(
  ({ set }, sort: ArtifactCatalogSort, direction: ArtifactCatalogDirection) => {
    set(pageCatalog.setSort$, sort, direction);
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

interface ArtifactCatalogRowRemovalFocus {
  readonly owner: string | null;
  readonly row: HTMLElement;
  readonly menu: HTMLElement | null;
  readonly viewport: HTMLElement;
  readonly targets: readonly HTMLElement[];
}

export const prepareArtifactCatalogRowRemovalFocus$ = command(
  ({ get }, artifactId: string, control: HTMLElement) => {
    const viewport = get(artifactCatalogViewport$);
    if (!get(pageCatalog.starredOnly$) || !viewport) {
      return null;
    }
    const rows = Array.from(
      viewport.querySelectorAll<HTMLElement>("tr[data-artifact-id]"),
    );
    const row = rows.find((element) => {
      return element.dataset.artifactId === artifactId;
    });
    if (!row) {
      return null;
    }
    const menu = control.closest<HTMLElement>('[role="menu"]');
    const trigger = row.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    const ownsMenu =
      menu !== null && trigger?.getAttribute("aria-controls") === menu.id;
    const active = document.activeElement;
    if (!(
      (row.contains(control) && row.contains(active)) ||
      (ownsMenu && menu.contains(active))
    )) {
      return null;
    }
    const index = rows.indexOf(row);
    const neighbors = [
      ...rows.slice(index + 1),
      ...rows.slice(0, index).reverse(),
    ];
    return {
      owner: get(authenticatedSessionKey$),
      row,
      menu: ownsMenu ? menu : null,
      viewport,
      targets: neighbors.flatMap((neighbor) => {
        const target = neighbor.querySelector<HTMLElement>(
          "[data-artifact-open]",
        );
        return target ? [target] : [];
      }),
    } satisfies ArtifactCatalogRowRemovalFocus;
  },
);

export const handoffArtifactCatalogRowRemovalFocus$ = command(
  (
    { get },
    focus: ArtifactCatalogRowRemovalFocus | null,
    signal: AbortSignal,
  ) => {
    if (!focus) {
      return;
    }
    animationFrame(
      () => {
        const active = document.activeElement;
        if (
          get(pageSignal$) !== signal ||
          get(authenticatedSessionKey$) !== focus.owner ||
          get(artifactCatalogViewport$) !== focus.viewport ||
          !get(pageCatalog.starredOnly$) ||
          focus.row.isConnected ||
          (active !== document.body &&
            !focus.row.contains(active) &&
            !focus.menu?.contains(active))
        ) {
          return;
        }
        const target =
          focus.targets.find((element) => {
            return element.isConnected;
          }) ?? (focus.viewport.isConnected ? focus.viewport : null);
        target?.focus({ preventScroll: true });
      },
      { signal },
    );
  },
);

export const reloadArtifactCatalog$ = pageCatalog.reload$;

export const artifactCatalog$ = pageCatalog.catalog$;

export const artifactCatalogPagingState$ = pageCatalog.pagingState$;

export const loadMoreArtifactCatalog$ = pageCatalog.loadMore$;

export const loadThroughArtifactCatalog$ = pageCatalog.loadThroughArtifact$;

export const scrollArtifactCardIntoViewRef$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(routeLibraryMode$)) {
      const artifactId = element.dataset.artifactId;
      if (artifactId && get(internalScrolledArtifactId$) === artifactId) {
        return;
      }
      if (artifactId) {
        // Restoring an unstarred row must not replay the initial deep-link scroll.
        set(internalScrolledArtifactId$, artifactId);
      }
    }
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
