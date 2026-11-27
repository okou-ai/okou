import { artifactLibraryPreviewsContract } from "@okouai/api-contracts/client/artifact-library-previews";
import type { ArtifactLibraryPreview } from "@okouai/api-contracts/contracts/artifact-library-previews";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import {
  createAttachmentPreviewRegistry,
  createAttachmentPreviewSignals,
  shouldRefreshArtifactPreview,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type {
  ArtifactCatalogCategory,
  ArtifactCatalogDirection,
  ArtifactCatalogKind,
  ArtifactCatalogListClientQuery,
  ArtifactCatalogListResponse,
  ArtifactDetail,
  ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";

import { accept } from "../../lib/accept.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { artifactDetailPreview } from "./artifact-catalog-preview.ts";
import { artifactCatalogRevision$ } from "../artifact-deletion.ts";
import { pageSignal$ } from "../page-signal.ts";
import { debounceCommand, resetSignal } from "../utils.ts";

// Every page uses the same query and page size for its cursor session.
const ARTIFACT_CATALOG_PAGE_SIZE = 60;
const ARTIFACT_CATALOG_SEARCH_DEBOUNCE_MS = 300;
const ARTIFACT_CARD_THUMBNAIL_WIDTH_PX = 640;

export type CatalogArtifact = ArtifactSummary & {
  /**
   * Load state of the thumbnail, created when the page's data arrives. A
   * reload replaces the page and its signals; an already-broken thumbnail
   * then reports its state again on the image's next load cycle.
   */
  readonly thumbnailLoad: ImageLoadSignals;
  readonly thumbnailUrl$: Computed<Promise<string | null>>;
};

export interface ArtifactCatalogPage {
  readonly artifacts: readonly CatalogArtifact[];
  readonly nextCursor: string | null;
}

export interface ArtifactCatalogQuery {
  readonly category: ArtifactCatalogCategory | null;
  readonly kind: ArtifactCatalogKind | null;
  readonly search: string;
  readonly direction: ArtifactCatalogDirection;
}

interface CatalogPageResponse extends ArtifactCatalogListResponse {
  readonly thumbnailPreviews$?: Computed<
    Promise<readonly ArtifactLibraryPreview[]>
  >;
}

type CatalogPageRequest = (
  createClient: ApiClientFactory,
  query: ArtifactCatalogListClientQuery,
  signal?: AbortSignal,
) => Promise<CatalogPageResponse>;

interface CatalogQuerySnapshot {
  readonly query: ArtifactCatalogListClientQuery;
  readonly request: CatalogPageRequest | null;
}

interface CatalogIdentity {
  readonly revision: number;
  readonly reloadVersion: number;
  readonly query: Promise<CatalogQuerySnapshot>;
}

interface LoadedArtifactCatalogPage extends ArtifactCatalogPage {
  readonly identity: CatalogIdentity;
}

interface CatalogPagingOperation {
  readonly identity: CatalogIdentity;
  readonly request: Promise<void>;
  readonly result: PromiseSettledResult<void> | null;
}

function withThumbnailLoad(
  page: CatalogPageResponse,
  identity: CatalogIdentity,
): LoadedArtifactCatalogPage {
  return {
    identity,
    artifacts: page.artifacts.map((artifact) => {
      const thumbnailPreview = artifact.thumbnail
        ? createAttachmentPreviewSignals(artifact.thumbnail.url, {
            thumbnailSize: { width: ARTIFACT_CARD_THUMBNAIL_WIDTH_PX },
          })
        : null;
      return {
        ...artifact,
        thumbnailLoad: createImageLoadSignals(),
        thumbnailUrl$: computed(async (get) => {
          if (!thumbnailPreview || !artifact.thumbnail) {
            return null;
          }
          const previews =
            page.thumbnailPreviews$ &&
            parseArtifactReference(
              publicAttachmentUrl(artifact.thumbnail.url),
              location.origin,
            )
              ? await get(page.thumbnailPreviews$)
              : [];
          const preview = previews.find(({ artifactId }) => {
            return artifactId === artifact.id;
          });
          if (preview) {
            const resolved = createAttachmentPreviewSignals(
              artifact.thumbnail.url,
              {
                thumbnailSize: { width: ARTIFACT_CARD_THUMBNAIL_WIDTH_PX },
                resolvedToken: {
                  token: preview.url,
                  expiresAt: preview.expiresAt,
                  contentType: preview.contentType,
                  publicUrl: null,
                },
              },
            );
            return await get(resolved.thumbnailUrl$);
          }
          // Public covers and share aliases keep their existing resolver.
          return await get(thumbnailPreview.thumbnailUrl$);
        }),
      };
    }),
    nextCursor: page.nextCursor,
  };
}

interface ArtifactCatalogSelection {
  readonly refreshArtifactPreviews$: Command<void, []>;
  readonly selectArtifact$: Command<void, [string | null]>;
  readonly reloadSelectedArtifactDetail$: Command<void, []>;
  readonly ensureSelectedArtifactPreview$: Command<
    Promise<AttachmentPreviewSignals | null>,
    [string, AbortSignal]
  >;
  readonly selectedArtifactDetail$: Computed<Promise<ArtifactDetail | null>>;
  readonly selectedArtifactPreview$: Computed<AttachmentPreviewSignals | null>;
}

export interface ArtifactCatalogViewSignals extends ArtifactCatalogSelection {
  readonly reload$: Command<void, []>;
  readonly catalog$: Computed<Promise<ArtifactCatalogPage>>;
  readonly pagingState$: Computed<"idle" | "loading" | "error">;
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
  readonly loadThroughArtifact$: Command<Promise<void>, [string, AbortSignal]>;
}

export interface ArtifactCatalogSignals extends ArtifactCatalogViewSignals {
  readonly selectedCategory$: Computed<ArtifactCatalogCategory | null>;
  readonly setCategory$: Command<void, [ArtifactCatalogCategory | null]>;
  readonly selectedKind$: Computed<ArtifactCatalogKind | null>;
  readonly setKind$: Command<void, [ArtifactCatalogKind | null]>;
  readonly search$: Computed<string>;
  readonly setSearch$: Command<Promise<void>, [string, AbortSignal]>;
  readonly direction$: Computed<ArtifactCatalogDirection>;
  readonly setDirection$: Command<void, [ArtifactCatalogDirection]>;
  readonly initializeQuery$: Command<void, [ArtifactCatalogQuery, AbortSignal]>;
  readonly cancelQuery$: Command<void, []>;
}

async function loadLibraryPreviews(
  createClient: ApiClientFactory,
  artifactIds: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await accept(
    createClient(artifactLibraryPreviewsContract).resolve({
      body: { artifactIds },
      fetchOptions: { signal },
    }),
    [200],
    signal,
    { showErrorToast: false },
  );
  return response.body.previews;
}

function artifactLibraryPageRequest(
  ownerSignal: AbortSignal,
): CatalogPageRequest {
  return async (createClient, query, signal) => {
    const requestSignal = signal
      ? AbortSignal.any([ownerSignal, signal])
      : ownerSignal;
    requestSignal.throwIfAborted();
    const result = await accept(
      createClient(artifactCatalogContract).list({
        query,
        fetchOptions: { signal: requestSignal },
      }),
      [200],
      requestSignal,
    );
    requestSignal.throwIfAborted();
    if (query.direction === undefined) {
      return result.body;
    }
    const artifactIds = result.body.artifacts
      .filter((artifact) => {
        return (
          artifact.thumbnail &&
          parseArtifactReference(
            publicAttachmentUrl(artifact.thumbnail.url),
            location.origin,
          )
        );
      })
      .map(({ id }) => {
        return id;
      });
    const requestPreviews = () => {
      return artifactIds.length === 0
        ? Promise.resolve([])
        : loadLibraryPreviews(createClient, artifactIds, requestSignal);
    };
    return {
      ...result.body,
      // The query owns cancellation; all cards share this lazy page request.
      thumbnailPreviews$: computed(() => {
        return requestPreviews();
      }),
    };
  };
}

function createArtifactLibraryQuerySignals(
  enabled$: Computed<Promise<boolean>>,
) {
  const internalSearch$ = state("");
  const internalKeyword$ = state(Promise.resolve(""));
  const internalDirection$ = state<ArtifactCatalogDirection>("desc");
  const internalRequest$ = state<CatalogPageRequest | null>(null);
  const resetRequests$ = resetSignal();
  const resetSearch$ = resetSignal();
  const restartRequests$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const requestSignal = set(resetRequests$, signal);
    set(internalRequest$, () => {
      return artifactLibraryPageRequest(requestSignal);
    });
  });
  const debounceSearch$ = debounceCommand(
    command((_context, search: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return search.trim();
    }),
    ARTIFACT_CATALOG_SEARCH_DEBOUNCE_MS,
  );
  const setSearch$ = command(
    async (
      { get, set },
      search: string,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(internalSearch$) === search) {
        return;
      }
      const searchSignal = set(resetSearch$, signal);
      set(internalSearch$, search);
      const keyword = search.trim()
        ? set(debounceSearch$, search, searchSignal)
        : Promise.resolve("");
      set(internalKeyword$, keyword);
      set(restartRequests$, signal);
      await keyword;
      signal.throwIfAborted();
      searchSignal.throwIfAborted();
    },
  );
  const setDirection$ = command(
    ({ set }, direction: ArtifactCatalogDirection) => {
      set(internalDirection$, direction);
    },
  );
  const initialize$ = command(
    ({ set }, query: ArtifactCatalogQuery, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(resetSearch$);
      set(internalSearch$, query.search);
      set(internalKeyword$, Promise.resolve(query.search.trim()));
      set(setDirection$, query.direction);
      set(restartRequests$, signal);
    },
  );
  const cancel$ = command(({ get, set }) => {
    set(resetSearch$);
    set(resetRequests$);
    set(internalRequest$, null);
    set(internalKeyword$, Promise.resolve(get(internalSearch$).trim()));
  });
  return {
    enabled$,
    search$: computed((get) => {
      return get(internalSearch$);
    }),
    keyword$: computed((get) => {
      return get(internalKeyword$);
    }),
    direction$: computed((get) => {
      return get(internalDirection$);
    }),
    request$: computed((get) => {
      return get(internalRequest$);
    }),
    setSearch$,
    setDirection$,
    initialize$,
    restartRequests$,
    cancel$,
  };
}

function createCatalogSource(
  chatThreadId?: string,
  driveAccountRevision$?: Computed<string>,
  library?: ReturnType<typeof createArtifactLibraryQuerySignals>,
) {
  const kind$ = state<ArtifactCatalogKind | null>(null);
  const category$ = state<ArtifactCatalogCategory | null>(null);
  const reloadVersion$ = state(0);
  const query$ = computed(async (get): Promise<CatalogQuerySnapshot> => {
    const kind = get(kind$);
    const category = get(category$);
    const enabled = library ? get(library.enabled$) : false;
    const keyword = library ? get(library.keyword$) : "";
    const direction = library ? get(library.direction$) : null;
    const request = library ? get(library.request$) : null;
    const libraryEnabled = await enabled;
    const trimmedKeyword = libraryEnabled ? (await keyword).trim() : "";
    return {
      query: {
        limit: ARTIFACT_CATALOG_PAGE_SIZE,
        ...(kind ? { kind } : {}),
        ...(libraryEnabled && category ? { category } : {}),
        ...(chatThreadId ? { chatThreadId } : {}),
        ...(libraryEnabled && direction ? { direction } : {}),
        ...(trimmedKeyword ? { keyword: trimmedKeyword } : {}),
      },
      request,
    };
  });
  const identity$ = computed((get): CatalogIdentity => {
    return {
      revision: get(artifactCatalogRevision$),
      reloadVersion: get(reloadVersion$),
      query: get(query$),
    };
  });
  const firstPage$ = computed(
    async (get): Promise<LoadedArtifactCatalogPage> => {
      const identity = get(identity$);
      const { query, request } = await identity.query;
      const createClient = get(apiClient$);
      if (library) {
        // Route setup installs the request owner before mounting this catalog.
        const page = request
          ? await request(createClient, query)
          : { artifacts: [], nextCursor: null };
        return withThumbnailLoad(page, identity);
      }
      const result = await accept(
        createClient(artifactCatalogContract).list({ query }),
        [200],
      );
      return withThumbnailLoad(result.body, identity);
    },
  );
  return {
    chatThreadId,
    driveAccountRevision$,
    kind$,
    category$,
    reloadVersion$,
    identity$,
    firstPage$,
  };
}

type CatalogSource = ReturnType<typeof createCatalogSource>;

function createCatalogPagingSignals({ identity$, firstPage$ }: CatalogSource) {
  const pages$ = state<readonly LoadedArtifactCatalogPage[]>([]);
  const operation$ = state<CatalogPagingOperation | null>(null);
  const pagingState$ = computed((get): "idle" | "loading" | "error" => {
    const operation = get(operation$);
    if (!operation || operation.identity !== get(identity$)) {
      return "idle";
    }
    return operation.result === null
      ? "loading"
      : operation.result.status === "rejected"
        ? "error"
        : "idle";
  });
  const resetPages$ = command(({ set }) => {
    set(pages$, []);
  });

  /**
   * Everything loaded so far, in server order. Reading this triggers the first
   * page fetch; `loadMore$` appends the rest.
   */
  const catalog$ = computed(async (get): Promise<ArtifactCatalogPage> => {
    const firstPage = await get(firstPage$);
    const appendedPages = get(pages$).filter((page) => {
      return page.identity === firstPage.identity;
    });
    const lastPage = appendedPages.at(-1) ?? firstPage;
    return {
      artifacts: [
        ...firstPage.artifacts,
        ...appendedPages.flatMap((page) => {
          return page.artifacts;
        }),
      ],
      nextCursor: lastPage.nextCursor,
    };
  });

  const loadPage$ = command(
    async (
      { get, set },
      identity: CatalogIdentity,
      signal: AbortSignal,
    ): Promise<void> => {
      const pages = get(pages$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(identity$) !== identity || get(pages$) !== pages) {
        return;
      }
      const cursor = loaded.nextCursor;
      if (!cursor) {
        return;
      }
      const snapshot = await identity.query;
      signal.throwIfAborted();
      if (get(identity$) !== identity || get(pages$) !== pages) {
        return;
      }
      const query = { ...snapshot.query, cursor };
      const createClient = get(apiClient$);
      const page = snapshot.request
        ? await snapshot.request(createClient, query, signal)
        : (
            await accept(
              createClient(artifactCatalogContract).list({
                query,
                fetchOptions: { signal },
              }),
              [200],
              signal,
            )
          ).body;
      signal.throwIfAborted();
      if (get(identity$) !== identity || get(pages$) !== pages) {
        return;
      }
      set(pages$, [
        ...pages.filter((page) => {
          return page.identity === identity;
        }),
        withThumbnailLoad(page, identity),
      ]);
    },
  );

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const identity = get(identity$);
      const previous = get(operation$);
      if (previous?.identity === identity && previous.result === null) {
        await previous.request;
        signal.throwIfAborted();
        return;
      }
      const operation: CatalogPagingOperation = {
        identity,
        request: set(loadPage$, identity, signal),
        result: null,
      };
      set(operation$, operation);
      const [result] = await Promise.allSettled([operation.request]);
      if (signal.aborted) {
        if (get(operation$) === operation) {
          set(operation$, null);
        }
        signal.throwIfAborted();
      }
      if (get(operation$) === operation) {
        set(operation$, { ...operation, result });
      }
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        throw reason;
      }
    },
  );

  return { catalog$, pagingState$, loadMore$, resetPages$ };
}

function createCatalogSelectionSignals({
  reloadVersion$,
  chatThreadId,
  driveAccountRevision$,
}: CatalogSource): ArtifactCatalogSelection {
  const previews = createAttachmentPreviewRegistry();
  const internalDetailVersion$ = state(0);
  const reloadSelectedArtifactDetail$ = command(({ set }) => {
    set(previews.refresh$);
    set(internalDetailVersion$, (version) => {
      return version + 1;
    });
  });
  const internalSelectedArtifactId$ = state<string | null>(null);
  const internalSelectedArtifactPreview$ =
    state<AttachmentPreviewSignals | null>(null);

  const selectArtifact$ = command(({ get, set }, artifactId: string | null) => {
    if (get(internalSelectedArtifactId$) === artifactId) {
      return;
    }
    set(internalSelectedArtifactId$, artifactId);
    set(internalSelectedArtifactPreview$, null);
  });

  const selectedArtifactDetail$ = computed(
    async (get): Promise<ArtifactDetail | null> => {
      get(reloadVersion$);
      get(artifactCatalogRevision$);
      get(internalDetailVersion$);
      if (driveAccountRevision$) {
        get(driveAccountRevision$);
      }
      const artifactId = get(internalSelectedArtifactId$);
      if (!artifactId) {
        return null;
      }
      const client = get(apiClient$)(artifactCatalogContract);
      const result = await accept(
        client.get({
          params: { artifactId },
          query: chatThreadId ? { chatThreadId } : {},
        }),
        [200, 404],
      );
      return result.status === 404 ? null : result.body;
    },
  );

  const ensureSelectedArtifactPreview$ = command(
    async ({ get, set }, artifactId: string, signal: AbortSignal) => {
      if (get(internalSelectedArtifactId$) !== artifactId) {
        return null;
      }
      const detail = await get(selectedArtifactDetail$);
      signal.throwIfAborted();
      if (get(internalSelectedArtifactId$) !== artifactId) {
        return null;
      }
      if (!detail) {
        set(internalSelectedArtifactPreview$, null);
        return null;
      }
      const source = artifactDetailPreview(detail);
      const registered = set(previews.register$, {
        url: source.url,
        contentType: source.contentType,
        refreshOnArtifactChange: shouldRefreshArtifactPreview(source.kind),
      });
      if (get(internalSelectedArtifactId$) === artifactId) {
        set(internalSelectedArtifactPreview$, registered);
      }
      return registered;
    },
  );

  return {
    refreshArtifactPreviews$: previews.refresh$,
    selectArtifact$,
    ensureSelectedArtifactPreview$,
    selectedArtifactDetail$,
    reloadSelectedArtifactDetail$,
    selectedArtifactPreview$: computed((get) => {
      return get(internalSelectedArtifactPreview$);
    }),
  };
}

function createCatalogView(source: CatalogSource) {
  const { catalog$, pagingState$, loadMore$, resetPages$ } =
    createCatalogPagingSignals(source);

  const loadThroughArtifact$ = command(
    async ({ get, set }, artifactId: string, signal: AbortSignal) => {
      const identity = get(source.identity$);
      let loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(source.identity$) !== identity) {
        return;
      }
      while (
        loaded.nextCursor &&
        !loaded.artifacts.some((artifact) => {
          return artifact.id === artifactId;
        })
      ) {
        const loadedCount = loaded.artifacts.length;
        const loadedCursor = loaded.nextCursor;
        await set(loadMore$, signal);
        signal.throwIfAborted();
        if (get(source.identity$) !== identity) {
          return;
        }
        loaded = await get(catalog$);
        signal.throwIfAborted();
        if (get(source.identity$) !== identity) {
          return;
        }
        if (
          loaded.artifacts.length === loadedCount &&
          loaded.nextCursor === loadedCursor
        ) {
          return;
        }
      }
    },
  );

  return {
    catalog$,
    pagingState$,
    loadMore$,
    loadThroughArtifact$,
    resetPages$,
    ...createCatalogSelectionSignals(source),
  };
}

/** Re-read the first page, discard old cursors, and refresh mutable previews. */
function createCatalogReload$(
  { reloadVersion$ }: CatalogSource,
  ...invalidations: readonly Command<void, []>[]
) {
  return command(({ set }) => {
    for (const invalidate of invalidations) {
      set(invalidate);
    }
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });
}

export function createArtifactCatalogSignals(
  libraryEnabled$: Computed<Promise<boolean>>,
): ArtifactCatalogSignals {
  const library = createArtifactLibraryQuerySignals(libraryEnabled$);
  const source = createCatalogSource(undefined, undefined, library);
  const { resetPages$, ...view } = createCatalogView(source);
  const reloadCatalog$ = createCatalogReload$(
    source,
    resetPages$,
    view.refreshArtifactPreviews$,
  );
  const setKind$ = command(({ get, set }, kind: ArtifactCatalogKind | null) => {
    if (get(source.kind$) === kind && get(source.category$) === null) {
      return;
    }
    set(source.kind$, kind);
    set(source.category$, null);
    set(library.restartRequests$, get(pageSignal$));
    set(resetPages$);
  });
  const setCategory$ = command(
    ({ get, set }, category: ArtifactCatalogCategory | null) => {
      if (get(source.category$) === category && get(source.kind$) === null) {
        return;
      }
      set(source.category$, category);
      set(source.kind$, null);
      set(library.restartRequests$, get(pageSignal$));
      set(resetPages$);
    },
  );
  const setSearch$ = command(
    async (
      { get, set },
      search: string,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(library.search$) === search) {
        return;
      }
      set(resetPages$);
      await set(library.setSearch$, search, signal);
    },
  );
  const setDirection$ = command(
    ({ get, set }, direction: ArtifactCatalogDirection) => {
      if (get(library.direction$) === direction) {
        return;
      }
      set(library.setDirection$, direction);
      set(library.restartRequests$, get(pageSignal$));
      set(resetPages$);
    },
  );
  return {
    ...view,
    selectedCategory$: computed((get) => {
      return get(source.category$);
    }),
    setCategory$,
    selectedKind$: computed((get) => {
      return get(source.kind$);
    }),
    setKind$,
    search$: library.search$,
    setSearch$,
    direction$: library.direction$,
    setDirection$,
    initializeQuery$: command(
      ({ set }, query: ArtifactCatalogQuery, signal: AbortSignal) => {
        set(source.kind$, query.kind);
        set(source.category$, query.category);
        set(library.initialize$, query, signal);
        set(reloadCatalog$);
      },
    ),
    cancelQuery$: command(({ set }) => {
      set(library.cancel$);
      set(resetPages$);
    }),
    reload$: command(({ get, set }) => {
      set(library.restartRequests$, get(pageSignal$));
      set(reloadCatalog$);
    }),
  };
}

/** Each chat shares one unfiltered first page. Each view owns its cursor and selection. */
export function createThreadArtifactCatalogs(
  chatThreadId: string,
  driveAccountRevision$: Computed<string>,
): {
  readonly gallery: ArtifactCatalogViewSignals;
  readonly resources: ArtifactCatalogViewSignals;
} {
  const source = createCatalogSource(chatThreadId, driveAccountRevision$);
  const { resetPages$: resetGallery$, ...gallery } = createCatalogView(source);
  const { resetPages$: resetResources$, ...resources } =
    createCatalogView(source);
  const reload$ = createCatalogReload$(
    source,
    resetGallery$,
    resetResources$,
    gallery.refreshArtifactPreviews$,
    resources.refreshArtifactPreviews$,
  );
  return {
    gallery: { ...gallery, reload$ },
    resources: { ...resources, reload$ },
  };
}
