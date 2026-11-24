import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type { ArtifactCatalogSetFavoriteResponse } from "@okouai/api-contracts/contracts/artifact-catalog";
import { command, computed, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { pageSignal$, pageVersion$ } from "../page-signal.ts";
import { NEVER_RESOLVED_PROMISE } from "../utils.ts";
import { pageCatalog } from "./artifact-catalog-instance.ts";
import {
  handoffArtifactCatalogRowRemovalFocus$,
  prepareArtifactCatalogRowRemovalFocus$,
} from "./artifact-catalog-signals.ts";

export type ArtifactFavoriteChange =
  | {
      readonly status: "changed";
      readonly starred: boolean;
      readonly revision: number;
    }
  | { readonly status: "unchanged" };

interface FavoriteChangeRequest {
  readonly artifactId: string;
  readonly starred: boolean;
  readonly expectedRevision?: number;
  readonly rowControl?: HTMLElement;
}

const artifactFavoriteClient$ = computed(async (get) => {
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const assertCurrent = () => {
    if (
      !identity ||
      !clerk.organization ||
      !clerk.user ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException("Artifact favorite owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    client: createClient(artifactCatalogContract, {
      getTokenGuard: () => {
        assertCurrent();
        return assertCurrent;
      },
    }),
  };
});

type FavoriteClient = Awaited<ReturnType<typeof artifactFavoriteClient$.read>>;

/** Route-owned transports retain cancellation without putting signals in reactive values. */
function favoriteRequests(ownerSignal: AbortSignal) {
  return {
    read: async ({ client, assertCurrent }: FavoriteClient) => {
      ownerSignal.throwIfAborted();
      assertCurrent();
      const result = await accept(
        client.listFavorites({ fetchOptions: { signal: ownerSignal } }),
        [200],
        ownerSignal,
      );
      ownerSignal.throwIfAborted();
      assertCurrent();
      return new Set(result.body.artifactIds);
    },
    write: async (
      { client, assertCurrent }: FavoriteClient,
      artifactId: string,
      starred: boolean,
      signal: AbortSignal,
    ) => {
      const requestSignal = AbortSignal.any([ownerSignal, signal]);
      requestSignal.throwIfAborted();
      assertCurrent();
      const result = await accept(
        client.setFavorite({
          params: { artifactId },
          body: { starred },
          fetchOptions: { signal: requestSignal },
        }),
        [200],
        requestSignal,
      );
      requestSignal.throwIfAborted();
      assertCurrent();
      return result.body;
    },
  };
}

function createFavoriteState() {
  const requests$ = state<ReturnType<typeof favoriteRequests> | null>(null);
  const reloadVersion$ = state(0);
  const drafts$ = state<ReadonlyMap<string, boolean>>(new Map());
  // Undo owns the latest intent even after a read invalidates its projection.
  const revisions$ = state<ReadonlyMap<string, number>>(new Map());
  // Request identity enforces per-artifact serialization across all mounted surfaces.
  const writes$ = state<
    ReadonlyMap<string, Promise<ArtifactCatalogSetFavoriteResponse>>
  >(new Map());
  const revision$ = state(0);
  const confirmedIds$ = computed(async (get): Promise<ReadonlySet<string>> => {
    get(reloadVersion$);
    const requests = get(requests$);
    if (!requests) {
      return NEVER_RESOLVED_PROMISE;
    }
    return await requests.read(await get(artifactFavoriteClient$));
  });
  const ids$ = computed(async (get): Promise<ReadonlySet<string>> => {
    const drafts = get(drafts$);
    const ids = new Set(await get(confirmedIds$));
    for (const [artifactId, draft] of drafts) {
      if (draft) {
        ids.add(artifactId);
      } else {
        ids.delete(artifactId);
      }
    }
    return ids;
  });
  const write$ = command(
    async (
      { get },
      artifactId: string,
      starred: boolean,
      signal: AbortSignal,
    ) => {
      const requests = get(requests$);
      if (!requests) {
        throw new DOMException("Artifact favorite page closed", "AbortError");
      }
      return await requests.write(
        await get(artifactFavoriteClient$),
        artifactId,
        starred,
        signal,
      );
    },
  );
  return {
    requests$,
    reloadVersion$,
    drafts$,
    revisions$,
    writes$,
    revision$,
    confirmedIds$,
    ids$,
    write$,
  };
}

function createArtifactFavoriteSignals() {
  const model = createFavoriteState();
  const change$ = command(
    async (
      { get, set },
      args: FavoriteChangeRequest,
      signal: AbortSignal,
    ): Promise<ArtifactFavoriteChange> => {
      signal.throwIfAborted();
      const { artifactId, starred, expectedRevision, rowControl } = args;
      const requests = get(model.requests$);
      const focus =
        !starred && rowControl
          ? set(prepareArtifactCatalogRowRemovalFocus$, artifactId, rowControl)
          : null;
      const ids = await get(model.ids$);
      signal.throwIfAborted();
      if (!requests || get(model.requests$) !== requests) {
        throw new DOMException("Artifact favorite page changed", "AbortError");
      }
      const previous = get(model.drafts$).get(artifactId);
      const reloadVersion = get(model.reloadVersion$);
      if (
        get(model.writes$).has(artifactId) ||
        (expectedRevision !== undefined &&
          get(model.revisions$).get(artifactId) !== expectedRevision) ||
        ids.has(artifactId) === starred
      ) {
        return { status: "unchanged" };
      }
      const revision = get(model.revision$) + 1;
      set(model.revision$, revision);
      set(
        model.revisions$,
        new Map(get(model.revisions$)).set(artifactId, revision),
      );
      const request = set(model.write$, artifactId, starred, signal);
      set(model.writes$, new Map(get(model.writes$)).set(artifactId, request));
      set(model.drafts$, new Map(get(model.drafts$)).set(artifactId, starred));
      set(handoffArtifactCatalogRowRemovalFocus$, focus, signal);
      const [result] = await Promise.allSettled([request]);
      signal.throwIfAborted();
      if (get(model.writes$).get(artifactId) === request) {
        const writes = new Map(get(model.writes$));
        writes.delete(artifactId);
        set(model.writes$, writes);
        const drafts = new Map(get(model.drafts$));
        if (result.status === "fulfilled") {
          drafts.set(artifactId, result.value.starred);
        } else if (
          previous !== undefined &&
          get(model.reloadVersion$) === reloadVersion
        ) {
          drafts.set(artifactId, previous);
        } else {
          drafts.delete(artifactId);
        }
        set(model.drafts$, drafts);
      }
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        throw reason;
      }
      signal.throwIfAborted();
      if (get(model.requests$) !== requests) {
        throw new DOMException("Artifact favorite page changed", "AbortError");
      }
      return { status: "changed", starred: result.value.starred, revision };
    },
  );
  return {
    ids$: model.confirmedIds$,
    drafts$: model.drafts$,
    pendingIds$: computed((get): ReadonlySet<string> => {
      return new Set(get(model.writes$).keys());
    }),
    initialize$: command(({ set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(model.requests$, favoriteRequests(signal));
    }),
    reload$: command(({ get, set }) => {
      const writes = get(model.writes$);
      set(
        model.drafts$,
        new Map(
          [...get(model.drafts$)].filter(([id]) => {
            return writes.has(id);
          }),
        ),
      );
      set(model.reloadVersion$, (version) => {
        return version + 1;
      });
    }),
    change$,
  };
}

// Neither a different workspace/account nor a new visit inherits drafts or undo ownership.
const artifactFavorites$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(pageVersion$);
  return createArtifactFavoriteSignals();
});

export const artifactFavoriteIds$ = computed((get) => {
  return get(get(artifactFavorites$).ids$);
});
export const artifactFavoriteDrafts$ = computed((get) => {
  return get(get(artifactFavorites$).drafts$);
});
export const artifactFavoritePendingIds$ = computed((get) => {
  return get(get(artifactFavorites$).pendingIds$);
});
export const initializeArtifactFavorites$ = command(
  ({ get, set }, signal: AbortSignal) => {
    set(get(artifactFavorites$).initialize$, signal);
  },
);
export const reloadArtifactFavorites$ = command(({ get, set }) => {
  set(get(artifactFavorites$).reload$);
});
const changeArtifactFavorite$ = command(
  async ({ get, set }, args: FavoriteChangeRequest, signal: AbortSignal) => {
    const { artifactId } = args;
    const favorites = get(artifactFavorites$);
    const change = await set(favorites.change$, args, signal);
    signal.throwIfAborted();
    if (get(artifactFavorites$) !== favorites || get(pageSignal$) !== signal) {
      throw new DOMException("Artifact favorite page changed", "AbortError");
    }
    if (
      change.status === "changed" &&
      change.starred &&
      get(pageCatalog.starredOnly$)
    ) {
      const request = get(pageCatalog.catalog$);
      const [catalog] = await Promise.allSettled([request]);
      signal.throwIfAborted();
      if (
        get(artifactFavorites$) === favorites &&
        get(pageSignal$) === signal &&
        get(pageCatalog.starredOnly$)
      ) {
        if (get(pageCatalog.catalog$) !== request) {
          // A replacement query may have started before this star was saved.
          set(pageCatalog.reload$);
        } else if (catalog.status === "rejected") {
          const reason: unknown = catalog.reason;
          throw reason;
        } else if (
          !catalog.value.artifacts.some((artifact) => {
            return artifact.id === artifactId;
          })
        ) {
          // Keep the current query and preview; cached Undo needs no invalidation.
          set(pageCatalog.reload$);
        }
      }
    }
    return change;
  },
);

export const setArtifactFavorite$ = command(
  async (
    { set },
    artifactId: string,
    starred: boolean,
    signal: AbortSignal,
  ) => {
    return await set(changeArtifactFavorite$, { artifactId, starred }, signal);
  },
);

export const setArtifactFavoriteFromRow$ = command(
  async (
    { set },
    artifactId: string,
    starred: boolean,
    control: HTMLElement,
    signal: AbortSignal,
  ) => {
    return await set(
      changeArtifactFavorite$,
      { artifactId, starred, rowControl: control },
      signal,
    );
  },
);

export const undoArtifactFavorite$ = command(
  async (
    { set },
    artifactId: string,
    revision: number,
    signal: AbortSignal,
  ) => {
    return await set(
      changeArtifactFavorite$,
      { artifactId, starred: true, expectedRevision: revision },
      signal,
    );
  },
);
