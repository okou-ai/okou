import {
  createAttachmentPreviewRegistry,
  createAttachmentPreviewSignals,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import { command, computed, state, type Command, type Computed } from "ccstate";
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
import { artifactCatalogRevision$ } from "../artifact-deletion.ts";

// First screen and every scroll step request the same page size. The server
// orders by `(createdAt, id)` and never reorders on update, so a cursor stays
// valid for the whole scroll session.
const ARTIFACT_CATALOG_PAGE_SIZE = 60;
const ARTIFACT_CARD_THUMBNAIL_WIDTH_PX = 640;

export type CatalogArtifact = ArtifactSummary & {
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

interface ArtifactCatalogSelection {
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
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
  readonly loadThroughArtifact$: Command<Promise<void>, [string, AbortSignal]>;
}

export interface ArtifactCatalogSignals extends ArtifactCatalogViewSignals {
  readonly selectedKind$: Computed<ArtifactCatalogKind | null>;
  readonly setKind$: Command<void, [ArtifactCatalogKind | null]>;
}

function createCatalogSource(chatThreadId?: string) {
  const kind$ = state<ArtifactCatalogKind | null>(null);
  const reloadVersion$ = state(0);
  const firstPage$ = computed(
    async (get): Promise<LoadedArtifactCatalogPage> => {
      const revision = get(artifactCatalogRevision$);
      get(reloadVersion$);
      const kind = get(kind$);
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
  return { chatThreadId, kind$, reloadVersion$, firstPage$ };
}

type CatalogSource = ReturnType<typeof createCatalogSource>;

function createCatalogPagingSignals({
  chatThreadId,
  kind$,
  firstPage$,
}: CatalogSource) {
  const pages$ = state<readonly LoadedArtifactCatalogPage[]>([]);
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
      const kind = get(kind$);
      const pages = get(pages$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(artifactCatalogRevision$) !== revision || get(pages$) !== pages) {
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
      if (get(artifactCatalogRevision$) !== revision || get(pages$) !== pages) {
        return;
      }
      set(pages$, [
        ...pages.filter((page) => {
          return page.revision === revision;
        }),
        withThumbnailLoad(result.body, revision),
      ]);
    },
  );

  return { catalog$, loadMore$, resetPages$ };
}

function createCatalogSelectionSignals(
  catalog$: Computed<Promise<ArtifactCatalogPage>>,
  { reloadVersion$, chatThreadId }: CatalogSource,
): ArtifactCatalogSelection {
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
        contentType: source.contentType,
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

function createCatalogView(source: CatalogSource) {
  const { catalog$, loadMore$, resetPages$ } =
    createCatalogPagingSignals(source);

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
    catalog$,
    loadMore$,
    loadThroughArtifact$,
    resetPages$,
    ...createCatalogSelectionSignals(catalog$, source),
  };
}

/** Re-read the first page and discard every view's cursors from the old page. */
function createCatalogReload$(
  { reloadVersion$ }: CatalogSource,
  ...resets: readonly Command<void, []>[]
) {
  return command(({ set }) => {
    for (const reset of resets) {
      set(reset);
    }
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });
}

export function createArtifactCatalogSignals(): ArtifactCatalogSignals {
  const source = createCatalogSource();
  const { resetPages$, ...view } = createCatalogView(source);
  const setKind$ = command(({ set }, kind: ArtifactCatalogKind | null) => {
    set(source.kind$, kind);
    set(resetPages$);
  });
  return {
    ...view,
    selectedKind$: computed((get) => {
      return get(source.kind$);
    }),
    setKind$,
    reload$: createCatalogReload$(source, resetPages$),
  };
}

/** Each chat shares one unfiltered first page. Each view owns its cursor and selection. */
export function createThreadArtifactCatalogs(chatThreadId: string): {
  readonly gallery: ArtifactCatalogViewSignals;
  readonly resources: ArtifactCatalogViewSignals;
} {
  const source = createCatalogSource(chatThreadId);
  const { resetPages$: resetGallery$, ...gallery } = createCatalogView(source);
  const { resetPages$: resetResources$, ...resources } =
    createCatalogView(source);
  const reload$ = createCatalogReload$(source, resetGallery$, resetResources$);
  return {
    gallery: { ...gallery, reload$ },
    resources: { ...resources, reload$ },
  };
}
