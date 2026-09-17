import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  presentationTemplatesContract,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplateDetail,
  type PresentationTemplatePreviewAsset,
  type PresentationTemplateSummary,
  type UpdatePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { SharedDatabaseBridge } from "../../shared-database/bridge.ts";
import { onRejection, retryTransientLoad, waitForOperation } from "../utils.ts";

export type { PresentationTemplateDetail, PresentationTemplateSummary };

type ImportedPresentationTemplateDetailLookup = (
  templateId: string,
) => Computed<Promise<PresentationTemplateDetail | null>>;

interface ImportedPresentationTemplateDetailResolver {
  readonly resolve: ImportedPresentationTemplateDetailLookup;
}

const presentationTemplatesVersion$ = state(0);
const presentationTemplatesSubscription$ = state<Promise<boolean> | null>(null);
const presentationTemplatesRealtimeReady$ = computed((get) => {
  const subscription = get(presentationTemplatesSubscription$);
  if (subscription === null) {
    throw new Error("Presentation template subscriptions were not initialized");
  }
  return subscription;
});
/**
 * A successful local delete permanently removes the database row. Keep its ID
 * hidden for the rest of this app session so an older in-flight catalog cannot
 * resurrect either the card or its preview cache.
 */
const deletedPresentationTemplateIds$ = state<ReadonlySet<string>>(new Set());
const importedPresentationTemplateDeletedIds$ = computed((get) => {
  return get(deletedPresentationTemplateIds$);
});

interface ImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateCatalogEntry[];
}

interface CachedImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateDetail[];
}

/**
 * The decks this workspace member can use. Their own decks come first, then
 * decks other members made visible to the workspace.
 */
const importedPresentationTemplateCatalog$ = computed(
  async (get): Promise<ImportedPresentationTemplateCatalog> => {
    get(presentationTemplatesVersion$);
    // Attach realtime before the baseline fetch so an update cannot be lost
    // between loading the catalog and starting its subscription.
    if (!(await get(presentationTemplatesRealtimeReady$))) {
      return { templates: [] };
    }
    const client = get(apiClient$)(presentationTemplatesContract);
    const result = await retryTransientLoad(() => {
      return accept(client.list(), [200], undefined, { showErrorToast: false });
    });
    return { templates: result.body };
  },
);

/** Refetch the catalog after a mutation or realtime catch-up. */
const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

const refreshAndLoadPresentationTemplates$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(refreshPresentationTemplates$);
    await waitForOperation(get(importedPresentationTemplateCatalog$), signal);
    signal.throwIfAborted();
  },
);

/**
 * A template is published by the analysis runner, outside any composer or
 * browser mutation. Subscribe once at the authenticated workspace boundary so
 * navigation cannot strand a newly published deck in the thread that started
 * the analysis.
 */
const acquirePresentationTemplateSubscriptions$ = command(
  async (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const bridge = await waitForOperation(initialization, signal);
    signal.throwIfAborted();
    if (!bridge) {
      return false;
    }
    const subscriptionIds = [crypto.randomUUID(), crypto.randomUUID()];
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      signal.removeEventListener("abort", dispose);
      for (const subscriptionId of subscriptionIds) {
        bridge.unsubscribeRealtime(subscriptionId);
      }
    };
    const invalidate = () => {
      if (!disposed) {
        set(refreshPresentationTemplates$);
      }
    };
    signal.addEventListener("abort", dispose, { once: true });
    await onRejection(async () => {
      await Promise.all(
        subscriptionIds.map(async (subscriptionId, index) => {
          await bridge.subscribeRealtime(
            subscriptionId,
            index === 0 ? "user" : "org",
            "presentationTemplatesChanged",
            invalidate,
            invalidate,
          );
        }),
      );
      signal.throwIfAborted();
    }, dispose);
    signal.throwIfAborted();
    return true;
  },
);

export const subscribePresentationTemplatesChanged$ = command(
  (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ) => {
    const subscription = set(
      acquirePresentationTemplateSubscriptions$,
      initialization,
      signal,
    );
    set(presentationTemplatesSubscription$, subscription);
    return subscription;
  },
);

interface ImportedPresentationTemplateCache {
  readonly detailByTemplateId: Map<
    string,
    Computed<Promise<PresentationTemplateDetail | null>>
  >;
  readonly previewAssetIdsByTemplateId: Map<string, readonly string[]>;
  readonly previewUrlByAssetId: Map<string, PresentationTemplatePreviewAsset>;
  /**
   * One stable buffer group per catalog template. The composer owns this map;
   * catalog eviction releases entries and closing the composer releases all of
   * them. Thumbnail groups are bounded by each deck's page count.
   */
  readonly imageBuffersByTemplateId: Map<
    string,
    ImportedPresentationTemplateImageBuffers
  >;
}

export type ImportedPresentationTemplateImageSlot = "a" | "b";

export interface ImportedPresentationTemplateLoadedImage {
  readonly desiredUrl: string;
  readonly sourceUrl: string;
  readonly slot: ImportedPresentationTemplateImageSlot;
}

export interface ImportedPresentationTemplateImageState {
  readonly active: ImportedPresentationTemplateLoadedImage | null;
  readonly failed: readonly ImportedPresentationTemplateLoadedImage[];
}

export interface ImportedPresentationTemplateImageSignals {
  readonly desiredUrl$: Computed<Promise<string | null>>;
  readonly state$: Computed<ImportedPresentationTemplateImageState>;
  readonly commitLoadedImage$: Command<
    Promise<void>,
    [ImportedPresentationTemplateLoadedImage, AbortSignal]
  >;
  readonly failImageLoad$: Command<
    Promise<void>,
    [ImportedPresentationTemplateLoadedImage, AbortSignal]
  >;
}

export interface ImportedPresentationTemplateImageBuffers {
  readonly card: ImportedPresentationTemplateImageSignals;
  readonly detail: ImportedPresentationTemplateImageSignals;
  readonly thumbnails: readonly ImportedPresentationTemplateImageSignals[];
}

export interface ImportedPresentationTemplatePickerItem {
  readonly template: PresentationTemplateSummary;
  readonly imageBuffers: ImportedPresentationTemplateImageBuffers;
}

interface ImportedPresentationTemplateImageDependencies {
  readonly resolveDetail$: ImportedPresentationTemplateDetailLookup;
  readonly cardHover$: Computed<ImportedPresentationTemplateHover | null>;
  readonly previewTemplateId$: Computed<string | null>;
  readonly previewSlideIndex$: Computed<number>;
}

function sameImportedPresentationTemplateLoadedImage(
  left: ImportedPresentationTemplateLoadedImage | null,
  right: ImportedPresentationTemplateLoadedImage,
): boolean {
  return (
    left?.desiredUrl === right.desiredUrl &&
    left.sourceUrl === right.sourceUrl &&
    left.slot === right.slot
  );
}

function createImportedPresentationTemplateImageSignals(
  desiredUrl$: Computed<Promise<string | null>>,
): ImportedPresentationTemplateImageSignals {
  const internalState$ = state<ImportedPresentationTemplateImageState>({
    active: null,
    failed: [],
  });
  const state$ = computed((get): ImportedPresentationTemplateImageState => {
    return get(internalState$);
  });
  const commitLoadedImage$ = command(
    async (
      { get, set },
      loadedImage: ImportedPresentationTemplateLoadedImage,
      signal: AbortSignal,
    ): Promise<void> => {
      // The DOM event identifies what finished loading; the signal remains the
      // source of truth for what the UI wants after any intervening navigation.
      const currentDesiredUrl = await get(desiredUrl$);
      signal.throwIfAborted();
      if (currentDesiredUrl !== loadedImage.desiredUrl) {
        return;
      }
      const current = get(internalState$);
      if (
        sameImportedPresentationTemplateLoadedImage(
          current.active,
          loadedImage,
        ) &&
        current.failed.length === 0
      ) {
        return;
      }
      set(internalState$, { active: loadedImage, failed: [] });
    },
  );
  const failImageLoad$ = command(
    async (
      { get, set },
      failedImage: ImportedPresentationTemplateLoadedImage,
      signal: AbortSignal,
    ): Promise<void> => {
      const currentDesiredUrl = await get(desiredUrl$);
      signal.throwIfAborted();
      if (currentDesiredUrl !== failedImage.desiredUrl) {
        return;
      }
      const current = get(internalState$);
      if (
        current.failed.some((candidate) => {
          return sameImportedPresentationTemplateLoadedImage(
            candidate,
            failedImage,
          );
        })
      ) {
        return;
      }
      set(internalState$, {
        ...current,
        failed: [...current.failed, failedImage],
      });
    },
  );
  return { desiredUrl$, state$, commitLoadedImage$, failImageLoad$ };
}

function synchronizeImportedPresentationTemplateImageBuffers(
  cache: ImportedPresentationTemplateCache,
  template: PresentationTemplateSummary,
  dependencies: ImportedPresentationTemplateImageDependencies,
): ImportedPresentationTemplateImageBuffers {
  const existing = cache.imageBuffersByTemplateId.get(template.id);
  const thumbnailCount = template.pageCount;
  if (existing?.thumbnails.length === thumbnailCount) {
    return existing;
  }
  const detail$ = dependencies.resolveDetail$(template.id);
  const cardDesiredUrl$ = computed(async (get): Promise<string | null> => {
    const hover = get(dependencies.cardHover$);
    const detail = await get(detail$);
    if (detail === null) {
      return null;
    }
    const index = hover?.templateId === template.id ? hover.index : 0;
    return detail.pageUrls[index] ?? detail.coverUrl;
  });
  const detailDesiredUrl$ = computed(async (get): Promise<string | null> => {
    const previewTemplateId = get(dependencies.previewTemplateId$);
    const previewSlideIndex = get(dependencies.previewSlideIndex$);
    if (previewTemplateId !== template.id) {
      return null;
    }
    const detail = await get(detail$);
    return (
      detail?.pageUrls[previewSlideIndex] ??
      detail?.pageUrls[0] ??
      detail?.coverUrl ??
      null
    );
  });
  const imageBuffers = {
    card:
      existing?.card ??
      createImportedPresentationTemplateImageSignals(cardDesiredUrl$),
    detail:
      existing?.detail ??
      createImportedPresentationTemplateImageSignals(detailDesiredUrl$),
    thumbnails: Array.from({ length: thumbnailCount }, (_, index) => {
      const thumbnailDesiredUrl$ = computed(
        async (get): Promise<string | null> => {
          if (get(dependencies.previewTemplateId$) !== template.id) {
            return null;
          }
          return (await get(detail$))?.pageUrls[index] ?? null;
        },
      );
      return (
        existing?.thumbnails[index] ??
        createImportedPresentationTemplateImageSignals(thumbnailDesiredUrl$)
      );
    }),
  } satisfies ImportedPresentationTemplateImageBuffers;
  cache.imageBuffersByTemplateId.set(template.id, imageBuffers);
  return imageBuffers;
}

function evictImportedPresentationTemplateCache(
  cache: ImportedPresentationTemplateCache,
  templateId: string,
): void {
  const removedPreviewAssetIds =
    cache.previewAssetIdsByTemplateId.get(templateId);
  cache.previewAssetIdsByTemplateId.delete(templateId);
  cache.imageBuffersByTemplateId.delete(templateId);
  cache.detailByTemplateId.delete(templateId);
  if (removedPreviewAssetIds === undefined) {
    return;
  }
  for (const previewAssetId of removedPreviewAssetIds) {
    cache.previewUrlByAssetId.delete(previewAssetId);
  }
}

function cachedPresentationTemplatePreviewAsset(
  cache: ImportedPresentationTemplateCache,
  previewAssetId: string,
): PresentationTemplatePreviewAsset {
  const asset = cache.previewUrlByAssetId.get(previewAssetId);
  if (asset === undefined) {
    throw new Error(
      `Presentation template preview is not cached: ${previewAssetId}`,
    );
  }
  return asset;
}

function synchronizeImportedPresentationTemplateCache(
  cache: ImportedPresentationTemplateCache,
  templates: readonly PresentationTemplateCatalogEntry[],
): readonly PresentationTemplateDetail[] {
  const templateIds = new Set(
    templates.map((template) => {
      return template.id;
    }),
  );
  for (const cachedTemplateId of cache.previewAssetIdsByTemplateId.keys()) {
    if (!templateIds.has(cachedTemplateId)) {
      evictImportedPresentationTemplateCache(cache, cachedTemplateId);
    }
  }
  for (const template of templates) {
    const previewAssetIds = template.previewAssets.map((asset) => {
      return asset.previewAssetId;
    });
    const nextPreviewAssetIds = new Set(previewAssetIds);
    for (const previousPreviewAssetId of cache.previewAssetIdsByTemplateId.get(
      template.id,
    ) ?? []) {
      if (!nextPreviewAssetIds.has(previousPreviewAssetId)) {
        cache.previewUrlByAssetId.delete(previousPreviewAssetId);
      }
    }
    for (const asset of template.previewAssets) {
      cache.previewUrlByAssetId.set(asset.previewAssetId, asset);
    }
    cache.previewAssetIdsByTemplateId.set(template.id, previewAssetIds);
  }
  return templates.map((template) => {
    const previewAssetIds = cache.previewAssetIdsByTemplateId.get(template.id);
    if (previewAssetIds === undefined) {
      throw new Error(
        `Presentation template detail is not cached: ${template.id}`,
      );
    }
    const previewAssets = previewAssetIds.map((previewAssetId) => {
      return cachedPresentationTemplatePreviewAsset(cache, previewAssetId);
    });
    return {
      ...template,
      coverUrl: previewAssets[0]?.url ?? template.coverUrl,
      pageUrls: previewAssets.map((asset) => {
        return asset.url;
      }),
      previewAssets,
    };
  });
}

function createImportedPresentationTemplatePickerItems$(
  templates$: Computed<Promise<readonly PresentationTemplateSummary[]>>,
  cache: ImportedPresentationTemplateCache,
  dependencies: ImportedPresentationTemplateImageDependencies,
) {
  return computed(
    async (get): Promise<readonly ImportedPresentationTemplatePickerItem[]> => {
      const pendingTemplates = get(templates$);
      const templates = await pendingTemplates;
      if (pendingTemplates !== get(templates$)) {
        // ccstate discards this obsolete result. In particular, it must not
        // create buffers for a template removed by the newer calculation.
        return templates.flatMap((template) => {
          const imageBuffers = cache.imageBuffersByTemplateId.get(template.id);
          return imageBuffers ? [{ template, imageBuffers }] : [];
        });
      }
      return templates.map((template) => {
        const imageBuffers =
          synchronizeImportedPresentationTemplateImageBuffers(
            cache,
            template,
            dependencies,
          );
        return { template, imageBuffers };
      });
    },
  );
}

function createCachedImportedPresentationTemplateCatalog$(
  catalog$: Computed<Promise<ImportedPresentationTemplateCatalog>>,
  cache: ImportedPresentationTemplateCache,
  deletedTemplateIds$: State<ReadonlySet<string>>,
) {
  return computed(
    async (get): Promise<CachedImportedPresentationTemplateCatalog> => {
      const deletedTemplateIds = get(deletedTemplateIds$);
      const pendingCatalog = get(catalog$);
      const catalog = await pendingCatalog;
      const retainedTemplates = catalog.templates.filter((template) => {
        return !deletedTemplateIds.has(template.id);
      });
      if (
        pendingCatalog !== get(catalog$) ||
        deletedTemplateIds !== get(deletedTemplateIds$)
      ) {
        // An obsolete async calculation still runs after ccstate invalidates
        // it. Only the current calculation may reconcile the shared maps.
        return {
          ...catalog,
          templates: retainedTemplates.map((template) => {
            return {
              ...template,
              pageUrls: template.previewAssets.map((asset) => {
                return asset.url;
              }),
            };
          }),
        };
      }
      return {
        ...catalog,
        templates: synchronizeImportedPresentationTemplateCache(
          cache,
          retainedTemplates,
        ),
      };
    },
  );
}

function createImportedPresentationTemplates$(
  catalog$: Computed<Promise<CachedImportedPresentationTemplateCatalog>>,
  deletedTemplateIds$: State<ReadonlySet<string>>,
  updatedTemplates$: State<readonly PresentationTemplateSummary[]>,
) {
  return computed(
    async (get): Promise<readonly PresentationTemplateSummary[]> => {
      const deletedTemplateIds = get(deletedTemplateIds$);
      const updatedTemplates = get(updatedTemplates$);
      return (await get(catalog$)).templates
        .filter((template) => {
          return !deletedTemplateIds.has(template.id);
        })
        .map((template) => {
          const updatedTemplate = updatedTemplates.find((candidate) => {
            return candidate.id === template.id;
          });
          if (
            updatedTemplate === undefined ||
            updatedTemplate.updatedAt <= template.updatedAt
          ) {
            return template;
          }
          return {
            ...template,
            title: updatedTemplate.title,
            visibility: updatedTemplate.visibility,
            updatedAt: updatedTemplate.updatedAt,
          };
        });
    },
  );
}

/**
 * Resolve one detail resource per uploaded template for this composer. The
 * resolver belongs to the composer signal group, so closing that composer
 * releases the whole keyed join instead of retaining template identities at
 * module scope.
 */
function createImportedPresentationTemplateDetailResolver(
  catalog$: Computed<Promise<CachedImportedPresentationTemplateCatalog>>,
  cache: ImportedPresentationTemplateCache,
): ImportedPresentationTemplateDetailResolver {
  const { detailByTemplateId } = cache;
  return {
    resolve: (templateId) => {
      const existing = detailByTemplateId.get(templateId);
      if (existing !== undefined) {
        return existing;
      }
      const detail$ = computed(
        async (get): Promise<PresentationTemplateDetail | null> => {
          return (
            (await get(catalog$)).templates.find((template) => {
              return template.id === templateId;
            }) ?? null
          );
        },
      );
      detailByTemplateId.set(templateId, detail$);
      return detail$;
    },
  };
}

interface ImportedPresentationTemplateHover {
  readonly templateId: string;
  readonly index: number;
}

function createImportedPresentationTemplateHoverSignals() {
  const internalCardHover$ = state<ImportedPresentationTemplateHover | null>(
    null,
  );
  const importedPresentationTemplateCardHover$ = computed((get) => {
    return get(internalCardHover$);
  });
  const setImportedPresentationTemplateCardHover$ = command(
    ({ set }, hover: ImportedPresentationTemplateHover | null) => {
      set(internalCardHover$, hover);
    },
  );
  return {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  };
}

function createImportedPresentationTemplateDetailSignals(
  resolveDetail$: ImportedPresentationTemplateDetailLookup,
) {
  const internalRequestedTemplateId$ = state<string | null>(null);
  const importedPresentationTemplateRequestedId$ = computed((get) => {
    return get(internalRequestedTemplateId$);
  });
  const importedPresentationTemplateDetail$ = computed(
    async (get): Promise<PresentationTemplateDetail | null> => {
      const templateId = get(internalRequestedTemplateId$);
      if (templateId === null) {
        return null;
      }
      return await get(resolveDetail$(templateId));
    },
  );
  const requestImportedPresentationTemplateDetail$ = command(
    ({ set }, templateId: string) => {
      set(internalRequestedTemplateId$, templateId);
    },
  );
  return {
    internalRequestedTemplateId$,
    importedPresentationTemplateRequestedId$,
    importedPresentationTemplateDetail$,
    requestImportedPresentationTemplateDetail$,
  };
}

function createUpdateImportedPresentationTemplate$(
  updatedTemplates$: State<readonly PresentationTemplateSummary[]>,
) {
  return command(
    async (
      { get, set },
      templateId: string,
      body: UpdatePresentationTemplateBody,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      const result = await accept(
        client.update({
          params: { templateId },
          body,
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(updatedTemplates$, (updatedTemplates) => {
        return [
          ...updatedTemplates.filter((template) => {
            return template.id !== templateId;
          }),
          result.body,
        ];
      });
    },
  );
}

function createImportedPresentationTemplatePreviewSignals(
  internalRequestedTemplateId$: State<string | null>,
) {
  const internalPreviewTemplateId$ = state<string | null>(null);
  const importedPresentationTemplatePreviewId$ = computed((get) => {
    return get(internalPreviewTemplateId$);
  });
  const internalPreviewSlideIndex$ = state(0);
  const importedPresentationTemplatePreviewSlideIndex$ = computed((get) => {
    return get(internalPreviewSlideIndex$);
  });
  const openImportedPresentationTemplatePreview$ = command(
    ({ set }, templateId: string, index: number) => {
      set(internalRequestedTemplateId$, templateId);
      set(internalPreviewTemplateId$, templateId);
      set(internalPreviewSlideIndex$, index);
    },
  );
  const closeImportedPresentationTemplatePreview$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
  });
  const selectImportedPresentationTemplatePreviewSlide$ = command(
    ({ set }, index: number) => {
      set(internalPreviewSlideIndex$, index);
    },
  );
  return {
    internalPreviewTemplateId$,
    internalPreviewSlideIndex$,
    importedPresentationTemplatePreviewId$,
    importedPresentationTemplatePreviewSlideIndex$,
    openImportedPresentationTemplatePreview$,
    closeImportedPresentationTemplatePreview$,
    selectImportedPresentationTemplatePreviewSlide$,
  };
}

/** Dialog-scoped state and mutations for persisted uploaded templates. */
export function createImportedPresentationTemplateSignals() {
  const cache: ImportedPresentationTemplateCache = {
    detailByTemplateId: new Map(),
    previewAssetIdsByTemplateId: new Map(),
    previewUrlByAssetId: new Map(),
    imageBuffersByTemplateId: new Map(),
  };
  const catalog$ = createCachedImportedPresentationTemplateCatalog$(
    importedPresentationTemplateCatalog$,
    cache,
    deletedPresentationTemplateIds$,
  );
  const internalUpdatedTemplates$ = state<
    readonly PresentationTemplateSummary[]
  >([]);
  const importedPresentationTemplates$ = createImportedPresentationTemplates$(
    catalog$,
    deletedPresentationTemplateIds$,
    internalUpdatedTemplates$,
  );
  const detailResolver = createImportedPresentationTemplateDetailResolver(
    catalog$,
    cache,
  );
  const { internalRequestedTemplateId$, ...detailSignals } =
    createImportedPresentationTemplateDetailSignals(detailResolver.resolve);
  const {
    internalPreviewTemplateId$,
    internalPreviewSlideIndex$,
    ...previewSignals
  } = createImportedPresentationTemplatePreviewSignals(
    internalRequestedTemplateId$,
  );

  const {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  } = createImportedPresentationTemplateHoverSignals();
  const importedPresentationTemplatePickerItems$ =
    createImportedPresentationTemplatePickerItems$(
      importedPresentationTemplates$,
      cache,
      {
        resolveDetail$: detailResolver.resolve,
        cardHover$: importedPresentationTemplateCardHover$,
        previewTemplateId$:
          previewSignals.importedPresentationTemplatePreviewId$,
        previewSlideIndex$:
          previewSignals.importedPresentationTemplatePreviewSlideIndex$,
      },
    );

  const updateImportedPresentationTemplate$ =
    createUpdateImportedPresentationTemplate$(internalUpdatedTemplates$);

  const deleteImportedPresentationTemplate$ = command(
    async (
      { get, set },
      templateId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      await accept(
        client.delete({
          params: { templateId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      evictImportedPresentationTemplateCache(cache, templateId);
      set(internalUpdatedTemplates$, (updatedTemplates) => {
        return updatedTemplates.filter((template) => {
          return template.id !== templateId;
        });
      });
      set(deletedPresentationTemplateIds$, (deletedTemplateIds) => {
        return new Set([...deletedTemplateIds, templateId]);
      });
      set(internalPreviewTemplateId$, null);
      set(internalPreviewSlideIndex$, 0);
      set(internalRequestedTemplateId$, null);
      set(internalCardHover$, null);
      await set(refreshAndLoadPresentationTemplates$, signal);
    },
  );

  const resetImportedPresentationTemplatePicker$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
    set(internalRequestedTemplateId$, null);
    set(internalCardHover$, null);
  });

  return {
    presentationTemplatesRealtimeReady$,
    retryImportedPresentationTemplates$: refreshPresentationTemplates$,
    importedPresentationTemplates$,
    importedPresentationTemplatePickerItems$,
    importedPresentationTemplateDeletedIds$,
    ...detailSignals,
    ...previewSignals,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
    updateImportedPresentationTemplate$,
    deleteImportedPresentationTemplate$,
    resetImportedPresentationTemplatePicker$,
  };
}
