import {
  createAttachmentPreviewRegistry,
  createAttachmentPreviewSignals,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type {
  ArtifactCatalogKind,
  ArtifactDetail,
  ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";

import { accept } from "../../lib/accept.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { apiClient$ } from "../api-client.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { artifactDetailPreview } from "./artifact-catalog-preview.ts";
import {
  artifactCatalogRevision$,
  createArtifactDeleteMenuSignals,
} from "../artifact-deletion.ts";

// First screen and every scroll step request the same page size. The server
// orders by `(createdAt, id)` and never reorders on update, so a cursor stays
// valid for the whole scroll session.
const ARTIFACT_CATALOG_PAGE_SIZE = 60;
const ARTIFACT_CARD_THUMBNAIL_WIDTH_PX = 640;

export type CatalogArtifact = ArtifactSummary & {
  readonly deletion: ReturnType<typeof createArtifactDeleteMenuSignals>;
  /**
   * Load state of the thumbnail, created when the page's data arrives. A
   * reload replaces the page and its signals; an already-broken thumbnail
   * then reports its state again on the image's next load cycle.
   */
  readonly thumbnailLoad: ImageLoadSignals;
  readonly thumbnailUrl$: Computed<Promise<string | null>>;
  /** Original video graph reused when this card opens in the viewer. */
  readonly videoPreview: AttachmentPreviewSignals | null;
  readonly videoUrl$: Computed<Promise<string | null>>;
};

export interface ArtifactCatalogPage {
  readonly artifacts: readonly CatalogArtifact[];
  readonly nextCursor: string | null;
}

interface LoadedArtifactCatalogPage extends ArtifactCatalogPage {
  readonly revision: number;
}

function withThumbnailLoad(
  page: {
    readonly artifacts: readonly ArtifactSummary[];
    readonly nextCursor: string | null;
  },
  revision: number,
): LoadedArtifactCatalogPage {
  return {
    revision,
    artifacts: page.artifacts.map((artifact) => {
      const videoPreview = artifact.videoSourceUrl
        ? createAttachmentPreviewSignals(artifact.videoSourceUrl)
        : null;
      const thumbnailPreview = artifact.thumbnail
        ? createAttachmentPreviewSignals(artifact.thumbnail.url, {
            thumbnailSize: { width: ARTIFACT_CARD_THUMBNAIL_WIDTH_PX },
          })
        : null;
      return {
        ...artifact,
        deletion: createArtifactDeleteMenuSignals(artifact),
        thumbnailLoad: createImageLoadSignals(),
        thumbnailUrl$: computed(async (get) => {
          return thumbnailPreview
            ? await get(thumbnailPreview.thumbnailUrl$)
            : null;
        }),
        videoPreview,
        videoUrl$: computed(async (get) => {
          return videoPreview ? await get(videoPreview.resourceUrl$) : null;
        }),
      };
    }),
    nextCursor: page.nextCursor,
  };
}

export interface ArtifactCatalogSignals {
  readonly selectedKind$: Computed<ArtifactCatalogKind | null>;
  readonly setKind$: Command<void, [ArtifactCatalogKind | null]>;
  readonly reload$: Command<void, []>;
  readonly catalog$: Computed<Promise<ArtifactCatalogPage>>;
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
  readonly loadThroughArtifact$: Command<Promise<void>, [string, AbortSignal]>;
  readonly selectArtifact$: Command<void, [string | null]>;
  readonly reloadSelectedArtifactDetail$: Command<void, []>;
  readonly ensureSelectedArtifactPreview$: Command<
    Promise<AttachmentPreviewSignals | null>,
    [string, AbortSignal]
  >;
  readonly selectedArtifactDetail$: Computed<Promise<ArtifactDetail | null>>;
  readonly selectedArtifactPreview$: Computed<AttachmentPreviewSignals | null>;
}

interface CatalogPagingState {
  readonly chatThreadId: string | undefined;
  readonly kind$: State<ArtifactCatalogKind | null>;
  readonly reloadVersion$: State<number>;
  readonly generation$: State<number>;
  readonly pages$: State<readonly LoadedArtifactCatalogPage[]>;
}

function createCatalogPagingSignals(paging: CatalogPagingState): {
  readonly catalog$: Computed<Promise<ArtifactCatalogPage>>;
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
} {
  const { chatThreadId } = paging;

  const firstPage$ = computed(
    async (get): Promise<LoadedArtifactCatalogPage> => {
      const revision = get(artifactCatalogRevision$);
      get(paging.reloadVersion$);
      const kind = get(paging.kind$);
      const client = get(apiClient$)(artifactCatalogContract);
      const result = await accept(
        client.list({
          query: {
            limit: ARTIFACT_CATALOG_PAGE_SIZE,
            ...(kind ? { kind } : {}),
            ...(chatThreadId ? { chatThreadId } : {}),
          },
        }),
        [200],
      );
      return withThumbnailLoad(result.body, revision);
    },
  );

  /**
   * Everything loaded so far, in server order. Reading this triggers the first
   * page fetch; `loadMore$` appends the rest.
   */
  const catalog$ = computed(async (get): Promise<ArtifactCatalogPage> => {
    const firstPage = await get(firstPage$);
    const appendedPages = get(paging.pages$).filter((page) => {
      return page.revision === firstPage.revision;
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

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const revision = get(artifactCatalogRevision$);
      const generation = get(paging.generation$);
      const kind = get(paging.kind$);
      const pages = get(paging.pages$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (
        get(artifactCatalogRevision$) !== revision ||
        get(paging.generation$) !== generation ||
        get(paging.pages$) !== pages
      ) {
        return;
      }
      const cursor = loaded.nextCursor;
      if (!cursor) {
        return;
      }
      const client = get(apiClient$)(artifactCatalogContract);
      const result = await accept(
        client.list({
          query: {
            limit: ARTIFACT_CATALOG_PAGE_SIZE,
            cursor,
            ...(kind ? { kind } : {}),
            ...(chatThreadId ? { chatThreadId } : {}),
          },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      if (
        get(artifactCatalogRevision$) !== revision ||
        get(paging.generation$) !== generation ||
        get(paging.pages$) !== pages
      ) {
        return;
      }
      set(paging.pages$, [
        ...pages.filter((page) => {
          return page.revision === revision;
        }),
        withThumbnailLoad(result.body, revision),
      ]);
    },
  );

  return { catalog$, loadMore$ };
}

function createCatalogSelectionSignals(
  catalog$: Computed<Promise<ArtifactCatalogPage>>,
  reloadVersion$: State<number>,
  chatThreadId: string | undefined,
): Pick<
  ArtifactCatalogSignals,
  | "selectArtifact$"
  | "reloadSelectedArtifactDetail$"
  | "ensureSelectedArtifactPreview$"
  | "selectedArtifactDetail$"
  | "selectedArtifactPreview$"
> {
  const internalDetailVersion$ = state(0);
  const reloadSelectedArtifactDetail$ = command(({ set }) => {
    set(internalDetailVersion$, (version) => {
      return version + 1;
    });
  });
  const internalSelectedArtifactId$ = state<string | null>(null);
  const internalSelectedArtifactPreview$ =
    state<AttachmentPreviewSignals | null>(null);
  const previews = createAttachmentPreviewRegistry();

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
      let preview: AttachmentPreviewSignals | undefined;
      if (detail.kind === "video" || detail.kind === "avatar") {
        const catalog = await get(catalog$);
        signal.throwIfAborted();
        const card = catalog.artifacts.find((artifact) => {
          return artifact.id === detail.id;
        });
        if (
          card?.videoPreview &&
          card.videoSourceUrl &&
          publicAttachmentUrl(card.videoSourceUrl) === source.url
        ) {
          preview = card.videoPreview;
        }
      }
      const registered = set(previews.register$, {
        url: source.url,
        ...(preview ? { preview } : {}),
      });
      if (get(internalSelectedArtifactId$) === artifactId) {
        set(internalSelectedArtifactPreview$, registered);
      }
      return registered;
    },
  );

  return {
    selectArtifact$,
    ensureSelectedArtifactPreview$,
    selectedArtifactDetail$,
    reloadSelectedArtifactDetail$,
    selectedArtifactPreview$: computed((get) => {
      return get(internalSelectedArtifactPreview$);
    }),
  };
}

/**
 * One independent catalog view. The `/artifacts` page holds a module-global
 * instance over the whole org catalog; each chat thread sidebar holds its own
 * instance narrowed by `chatThreadId`. Loaded pages live in the instance, so a
 * closed sidebar reopens on its cache while `reload$` refreshes the first page.
 */
export function createArtifactCatalogSignals(
  options: { readonly chatThreadId?: string } = {},
): ArtifactCatalogSignals {
  const internalKind$ = state<ArtifactCatalogKind | null>(null);
  const internalReload$ = state(0);
  const internalGeneration$ = state(0);
  const internalPages$ = state<readonly LoadedArtifactCatalogPage[]>([]);

  const resetPages$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });

  const setKind$ = command(({ set }, kind: ArtifactCatalogKind | null) => {
    set(internalKind$, kind);
    set(resetPages$);
  });

  /**
   * Re-read the first page. Later pages are dropped rather than re-fetched:
   * new artifacts always land at the head, so the first page is the only one
   * that can have changed.
   */
  const reload$ = command(({ set }) => {
    set(resetPages$);
    set(internalReload$, (version) => {
      return version + 1;
    });
  });

  const { catalog$, loadMore$ } = createCatalogPagingSignals({
    chatThreadId: options.chatThreadId,
    kind$: internalKind$,
    reloadVersion$: internalReload$,
    generation$: internalGeneration$,
    pages$: internalPages$,
  });
  const selection = createCatalogSelectionSignals(
    catalog$,
    internalReload$,
    options.chatThreadId,
  );

  const loadThroughArtifact$ = command(
    async ({ get, set }, artifactId: string, signal: AbortSignal) => {
      let loaded = await get(catalog$);
      signal.throwIfAborted();
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
        loaded = await get(catalog$);
        signal.throwIfAborted();
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
    selectedKind$: computed((get) => {
      return get(internalKind$);
    }),
    setKind$,
    reload$,
    catalog$,
    loadMore$,
    loadThroughArtifact$,
    ...selection,
  };
}
