import { isDesktopAuthFlow } from "../lib/desktop-auth-flow.ts";
import { command, computed, state, type Command } from "ccstate";
import { match } from "path-to-regexp";
import type { RoutePath } from "./route-paths";
import {
  clerk$,
  clerkUser$,
  needsOrgSelection$,
  resolveAppAuthUrl,
} from "./auth.ts";
import { hash, pathname, pushState, replaceState, search } from "./location.ts";
import { setPageSignal$ } from "./page-signal.ts";
import { clearPage$ } from "./react-router.ts";
import { rootSignal$ } from "./root-signal.ts";
import { bridgeConnected$ } from "./shared-database-bridge-state.ts";
import { detach, onDomEventFn, Reason, resetSignal } from "./utils.ts";
import { logger } from "./log.ts";
import {
  capturePageView,
  markBootstrapRouteSetup$,
  markNavigationPushState$,
} from "../lib/posthog.ts";
import { recordAdAttribution$ } from "./bootstrap/ad-attribution.ts";

const L = logger("Route");

const reloadPathname$ = state(0);
const internalHistoryState$ = state<unknown>(window.history.state);

export const pathname$ = computed((get) => {
  get(reloadPathname$);
  return pathname();
});

export const searchParams$ = computed((get) => {
  get(reloadPathname$);
  return new URLSearchParams(search());
});

export const hash$ = computed((get) => {
  get(reloadPathname$);
  return hash();
});

export const historyState$ = computed((get) => {
  return get(internalHistoryState$);
});

export const updateSearchParams$ = command(
  ({ set }, searchParams: URLSearchParams, historyState: unknown = {}) => {
    const str = searchParams.toString();
    pushState(historyState, "", `${pathname()}${str ? `?${str}` : ""}`);
    set(internalHistoryState$, historyState);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export const replaceSearchParams$ = command(
  (
    { set },
    searchParams: URLSearchParams,
    historyState: unknown = {},
    hash = "",
  ) => {
    const str = searchParams.toString();
    replaceState(
      historyState,
      "",
      `${pathname()}${str ? `?${str}` : ""}${hash}`,
    );
    set(internalHistoryState$, historyState);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export const replacePathSilently$ = command(
  (
    { set },
    pathnameTemplate: Parameters<typeof generateRouterPath>[0],
    pathParams?: Parameters<typeof generateRouterPath>[1],
    searchParams?: URLSearchParams,
  ) => {
    const newPath = generateRouterPath(pathnameTemplate, pathParams);
    const searchStr = searchParams?.toString();
    replaceState({}, "", `${newPath}${searchStr ? `?${searchStr}` : ""}`);
    set(internalHistoryState$, {});
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

interface Route {
  path: string;
  setup: Command<Promise<void> | void, [AbortSignal]>;
  analytics?: boolean;
}

const internalRouteConfig$ = state<Route[] | undefined>(undefined);

function findRoute(
  config: readonly Route[],
  currentPath: string,
): Route | null {
  for (const route of config) {
    const matcher = match(route.path, { decode: decodeURIComponent });
    const result = matcher(currentPath);
    if (result) {
      return route;
    }
  }

  return null;
}

const currentRoute$ = computed((get) => {
  const config = get(internalRouteConfig$);
  if (!config) {
    return null;
  }

  return findRoute(config, get(pathname$));
});

const clearPageForRouteBoundary$ = command(
  ({ get, set }, nextPathname: string) => {
    const config = get(internalRouteConfig$);
    const nextRoute = config ? findRoute(config, nextPathname) : null;
    if (get(currentRoute$) !== nextRoute) {
      set(clearPage$);
    }
  },
);

export const pathParams$ = computed((get) => {
  const currentRoute = get(currentRoute$);
  if (!currentRoute) {
    return undefined;
  }
  const matcher = match(currentRoute.path, { decode: decodeURIComponent });
  const currentPath = get(pathname$);
  const result = matcher(currentPath);
  return result ? result.params : undefined;
});

const resetRouteSignal$ = resetSignal();

const loadRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  const routeSignal = set(
    resetRouteSignal$,
    ...([signal].filter(Boolean) as AbortSignal[]),
  );

  const currentRoute = get(currentRoute$);
  if (!currentRoute) {
    throw new Error("No route matches, pathname: " + get(pathname$));
  }
  set(markBootstrapRouteSetup$, currentRoute.path);
  L.debug("loading route", currentRoute.path);
  if (currentRoute.analytics !== false) {
    set(recordAdAttribution$, get(searchParams$));
  }

  const [setup] = await Promise.allSettled([
    set(currentRoute.setup, routeSignal),
  ]);
  signal.throwIfAborted();
  // Navigation may replace a route during its setup. The replacement owns the
  // page now; cancellation of the old route does not cancel app bootstrap.
  if (routeSignal.aborted) {
    return;
  }
  if (setup.status === "rejected") {
    throw setup.reason;
  }
  if (currentRoute.analytics !== false) {
    capturePageView();
  }
});

const navigateToDefaultWhenInvalid$ = command(({ get, set }) => {
  const config = get(internalRouteConfig$);

  if (!config) {
    return;
  }

  if (!get(currentRoute$)) {
    set(reloadPathname$, (x) => {
      return x + 1;
    });
    pushState({}, "", "/");
    set(internalHistoryState$, {});
  }
});

export const initRoutes$ = command(
  async ({ set }, config: readonly Route[], signal: AbortSignal) => {
    set(internalRouteConfig$, config as Route[]);
    set(navigateToDefaultWhenInvalid$);

    window.addEventListener(
      "popstate",
      onDomEventFn(async (event: PopStateEvent) => {
        set(internalHistoryState$, event.state);
        set(clearPageForRouteBoundary$, pathname());
        set(reloadPathname$, (x) => {
          return x + 1;
        });
        set(navigateToDefaultWhenInvalid$);
        await set(loadRoute$, signal);
      }),
      { signal },
    );

    await set(loadRoute$, signal);
  },
);

interface NavigateOptions {
  searchParams?: URLSearchParams;
  hash?: string;
  replace?: boolean;
}

function routeHash(hash: string | undefined): string {
  if (!hash) {
    return "";
  }
  return hash.startsWith("#") ? hash : `#${hash}`;
}

const navigate$ = command(
  async (
    { get, set },
    pathname: string,
    options: NavigateOptions,
    signal: AbortSignal,
  ) => {
    const searchStr = options.searchParams?.toString();
    const newPath = `${pathname}${searchStr ? `?${searchStr}` : ""}${routeHash(options.hash)}`;
    L.debug(
      "navigating to",
      isDesktopAuthFlow(new URL(newPath, location.origin)) ? pathname : newPath,
    );
    set(clearPageForRouteBoundary$, pathname);
    if (options.replace) {
      replaceState({}, "", newPath);
    } else {
      pushState({}, "", newPath);
      set(markNavigationPushState$);
    }
    set(internalHistoryState$, {});
    set(reloadPathname$, (x) => {
      return x + 1;
    });
    // Use rootSignal$ (not the caller's route signal) so the new route gets
    // a fresh, non-aborted signal.  resetRouteSignal$ inside loadRoute$ will
    // abort the previous route's controller, which would poison any signal
    // derived from it — passing the caller's signal here causes the new
    // route's signal to be born-aborted.
    await set(loadRoute$, get(rootSignal$));
    signal.throwIfAborted();
  },
);

export const detachedNavigateTo$ = command(
  (
    { set, get },
    pathname: Parameters<typeof generateRouterPath>[0],
    options?: {
      pathParams?: Parameters<typeof generateRouterPath>[1];
      searchParams?: URLSearchParams;
      hash?: string;
      replace?: boolean;
    },
  ) => {
    // eslint-disable-next-line ccstate/no-detach-in-signals -- rootSignal$ owns navigation after its event callback returns
    detach(
      set(
        navigate$,
        generateRouterPath(pathname, options?.pathParams),
        options ?? {},
        get(rootSignal$),
      ),
      Reason.Entrance,
    );
  },
);

type ExtractParamSegment<T extends string> = T extends `:${infer Param}`
  ? Record<Param, string>
  : Record<never, never>;

type ExtractParamSegments<T extends string> =
  T extends `${infer Segment}/${infer Rest}`
    ? ExtractParamSegment<Segment> & ExtractParamSegments<Rest>
    : ExtractParamSegment<T>;

type ExtractParams<T extends string> = T extends string
  ? keyof ExtractParamSegments<T> extends never
    ? undefined
    : ExtractParamSegments<T>
  : never;

export type RouterPathParams<T extends RoutePath = RoutePath> =
  ExtractParams<T>;

export const generateRouterPath = <T extends RoutePath>(
  path: T,
  pathParams?: ExtractParams<T>,
): string => {
  if (!pathParams || Object.keys(pathParams).length === 0) {
    return path;
  }
  let _path = path as string;
  for (const [key, value] of Object.entries(pathParams)) {
    _path = _path.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  return _path;
};

export const setupPageWrapper = (
  fn: Command<Promise<void> | void, [AbortSignal]>,
) => {
  return command(async ({ set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    await set(fn, signal);
  });
};

/**
 * Wraps a page setup function with authentication requirement.
 * Opens sign-in dialog if user is not authenticated.
 * Also redirects to the web app's choose-organization page when the user
 * needs to select an organization.
 */
export const setupAuthPageWrapper = (
  fn: Command<Promise<void> | void, [AbortSignal]>,
) => {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.loaded) {
      return;
    }

    // Wait out Clerk's transitive state instead of reading `clerk.user`: while
    // `setActive()` navigates, the user is `undefined` rather than signed out,
    // and redirecting here would bounce a completed sign-in back to the form.
    const user = await get(clerkUser$);
    signal.throwIfAborted();

    if (!user) {
      const signInUrl = new URL(
        clerk.buildSignInUrl({ redirectUrl: location.href }),
      );
      L.info("redirect unauthenticated user to app sign-in", {
        currentUrl: location.href,
        signInUrl: signInUrl.toString(),
        redirectUrl: signInUrl.searchParams.get("redirect_url"),
      });
      window.location.href = signInUrl.toString();
      return;
    }

    const needsSelection = await get(needsOrgSelection$);
    signal.throwIfAborted();

    if (needsSelection) {
      L.debug(
        "redirect to choose-organization because org selection is needed",
      );
      window.location.href = resolveAppAuthUrl(
        "/sign-in/tasks/choose-organization",
      );
      return;
    }

    await get(bridgeConnected$);
    signal.throwIfAborted();
    await set(setupPageWrapper(fn), signal);
  });
};
