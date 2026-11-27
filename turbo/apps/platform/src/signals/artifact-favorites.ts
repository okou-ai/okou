import { command, computed, state } from "ccstate";
import { artifactFavoritesContract } from "@okouai/api-contracts/client/artifact-favorites";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";

import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { rootSignal$ } from "./root-signal.ts";
import { navigateTo$ } from "./route.ts";
import { ROUTES } from "./route-paths.ts";
import { onDomEventFn, resetSignal } from "./utils.ts";

export const artifactFavoritesEnabled$ = computed(async (get) => {
  const owner = get(authenticatedSessionKey$);
  const switches = await get(featureSwitches$);
  return Boolean(
    owner &&
    switches[FeatureSwitchKey.ArtifactLibrary] &&
    switches[FeatureSwitchKey.Star],
  );
});

const revision$ = state(0);
export const artifactFavoritesRevision$ = computed((get) => {
  return get(revision$);
});

export const changeArtifactFavorite$ = command(
  async (
    { get, set },
    artifactId: string,
    favorited: boolean,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const owner = get(authenticatedSessionKey$);
    const enabled = await get(artifactFavoritesEnabled$);
    signal.throwIfAborted();
    if (!enabled || !owner || owner !== get(authenticatedSessionKey$)) {
      return false;
    }
    const client = get(apiClient$)(artifactFavoritesContract);
    if (favorited) {
      await accept(
        client.create({ body: { artifactId }, fetchOptions: { signal } }),
        [200],
        signal,
      );
    } else {
      await accept(
        client.remove({ params: { artifactId }, fetchOptions: { signal } }),
        [200],
        signal,
      );
    }
    if (owner !== get(authenticatedSessionKey$)) {
      return false;
    }
    set(revision$, (revision) => {
      return revision + 1;
    });
    toast.success(
      i18n.t(($) => {
        return favorited
          ? $.artifacts.favorites.added
          : $.artifacts.favorites.removed;
      }),
      favorited
        ? {
            ...TEXT_TOAST_ACTION,
            action: {
              label: i18n.t(($) => {
                return $.artifacts.favorites.view;
              }),
              onClick: onDomEventFn(async () => {
                if (await get(artifactFavoritesEnabled$)) {
                  await set(
                    navigateTo$,
                    ROUTES.artifacts,
                    {
                      searchParams: new URLSearchParams({
                        collection: "favorites",
                      }),
                    },
                    get(rootSignal$),
                  );
                }
              }),
            },
          }
        : undefined,
    );
    return true;
  },
);

export interface ArtifactFavoriteTarget {
  readonly artifactId: string;
  readonly favorited: boolean;
}

export const emptyArtifactFavoriteTarget$ = computed(() => {
  return Promise.resolve<ArtifactFavoriteTarget | null>(null);
});

export type ArtifactFavoriteSource =
  { readonly url: string } | ArtifactFavoriteTarget;

type ResolveFavorite = (
  client: ApiClientFactory,
) => Promise<ArtifactFavoriteTarget | null>;

function createArtifactFavoriteSession(source: ArtifactFavoriteSource) {
  const request$ = state<ResolveFavorite | null>(null);
  const confirmed$ = state<ArtifactFavoriteTarget | null>(null);
  const resolved$ = computed(async (get) => {
    const request = get(request$);
    if (!(await get(artifactFavoritesEnabled$))) {
      return null;
    }
    if ("artifactId" in source) {
      return source;
    }
    return request ? await request(get(apiClient$)) : null;
  });
  const target$ = computed(async (get) => {
    const resolved = await get(resolved$);
    const confirmed = get(confirmed$);
    return resolved && confirmed?.artifactId === resolved.artifactId
      ? confirmed
      : resolved;
  });
  return {
    source,
    target$,
    initialize$: command(({ set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!("url" in source)) {
        return;
      }
      set(request$, () => {
        return async (createClient: ApiClientFactory) => {
          const result = await accept(
            createClient(artifactFavoritesContract).resolve({
              query: { url: source.url },
              fetchOptions: { signal },
            }),
            [200, 400, 401, 403, 404],
            signal,
          );
          return result.status === 200 ? result.body : null;
        };
      });
    }),
    toggle$: command(async ({ get, set }, signal: AbortSignal) => {
      const target = await get(target$);
      signal.throwIfAborted();
      if (!target) {
        return;
      }
      const changed = await set(
        changeArtifactFavorite$,
        target.artifactId,
        !target.favorited,
        signal,
      );
      if (changed) {
        set(confirmed$, { ...target, favorited: !target.favorited });
      }
    }),
  };
}

export type ArtifactFavoriteSession = ReturnType<
  typeof createArtifactFavoriteSession
>;

function createArtifactFavoriteScope() {
  const source$ = state<{
    readonly source: ArtifactFavoriteSource;
    readonly owner: string;
  } | null>(null);
  const reset$ = resetSignal();
  const session$ = computed((get) => {
    const selected = get(source$);
    return selected && selected.owner === get(authenticatedSessionKey$)
      ? createArtifactFavoriteSession(selected.source)
      : null;
  });
  return {
    session$,
    select$: command(
      (
        { get, set },
        source: ArtifactFavoriteSource | null,
        parentSignal: AbortSignal,
      ) => {
        const signal = set(reset$, parentSignal);
        const owner = get(authenticatedSessionKey$);
        const selected = source && owner ? { source, owner } : null;
        set(source$, selected);
        const session = get(session$);
        if (session) {
          set(session.initialize$, signal);
        }
        signal.addEventListener(
          "abort",
          () => {
            if (get(source$) === selected) {
              set(source$, null);
            }
          },
          { once: true },
        );
      },
    ),
  };
}

// Only the selected preview owns a resolver; there is no URL or card cache.
const scopes = Object.freeze({
  dialog: createArtifactFavoriteScope(),
  sidebar: createArtifactFavoriteScope(),
  page: createArtifactFavoriteScope(),
});
export function artifactFavoriteScope(surface: keyof typeof scopes) {
  return scopes[surface];
}
