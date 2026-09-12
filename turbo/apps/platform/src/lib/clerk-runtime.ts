import { loadClerkJSScript } from "@clerk/shared/loadClerkJsScript";
import { loadScript } from "@clerk/shared/loadScript";
import type { BrowserClerk, ClerkOptions } from "@clerk/shared/types";
import type { ClerkUIConstructor } from "@clerk/shared/ui";
import type { ui } from "@clerk/ui";
import { createDeferredPromise } from "../signals/utils.ts";
import { CLERK_JS_VERSION, CLERK_UI_VERSION } from "./clerk-versions.ts";

interface ClerkRuntimeOptions {
  readonly publishableKey: string;
  readonly loadOptions: ClerkRuntimeLoadOptions;
}

interface ClerkRuntimeLoadOptions {
  readonly afterSignOutUrl: string;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface ClerkBrowserRuntime {
  readonly clerk: BrowserClerk;
  /**
   * Loads the installed Clerk UI export and hands it to the shared core.
   * Auth pages and account switching request it; other app routes keep the
   * core-only download.
   */
  readonly ensureUiLoaded: () => Promise<typeof ui>;
  readonly loaded: Promise<void>;
}

type EarlyClerkBootstrap = NonNullable<Window["__okouClerkBootstrap"]>;
type ResolveClerkUI = EarlyClerkBootstrap["resolveClerkUI"];
type ClerkRouter = NonNullable<ClerkOptions["routerPush"]>;
type ClerkRouterMetadata = Parameters<ClerkRouter>[1];

function delegateClerkNavigation(
  method: keyof NonNullable<Window["__okouClerkRouter"]>,
  url: string,
  metadata?: ClerkRouterMetadata,
): unknown {
  const router = window.__okouClerkRouter?.[method];
  if (router) {
    return router(url, metadata);
  }
  // Outside an owning route, preserve Clerk's full-document navigation.
  return metadata?.windowNavigate(url);
}

const clerkRouterPush: ClerkRouter = (url, metadata) => {
  return delegateClerkNavigation("push", url, metadata);
};

const clerkRouterReplace: ClerkRouter = (url, metadata) => {
  return delegateClerkNavigation("replace", url, metadata);
};

/**
 * Installs route-owned handlers behind the callbacks Clerk captured at load.
 * Cleanup only removes the same registration, so a newer route cannot be
 * detached by an older React ref callback.
 */
export function registerClerkRouter(
  router: NonNullable<Window["__okouClerkRouter"]>,
): () => void {
  window.__okouClerkRouter = router;
  return () => {
    if (window.__okouClerkRouter === router) {
      Reflect.deleteProperty(window, "__okouClerkRouter");
    }
  };
}

function isBrowserClerk(value: unknown): value is BrowserClerk {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "load") === "function" &&
    typeof Reflect.get(value, "on") === "function"
  );
}

function createClerkUiLoader(
  resolveClerkUI: ResolveClerkUI,
  earlyUi: Promise<typeof ui> | undefined,
  signal: AbortSignal,
): () => Promise<typeof ui> {
  let loadPromise: Promise<typeof ui> | undefined;
  return () => {
    loadPromise ??= (async () => {
      signal.throwIfAborted();
      if (earlyUi) {
        await earlyUi;
      } else if (!window.__okouClerkUI) {
        const src = document.querySelector<HTMLMetaElement>(
          'meta[name="okou-clerk-ui-script"]',
        )?.content;
        if (!src) {
          throw new Error("Clerk UI asset URL is missing");
        }
        await loadScript(src, {
          async: true,
          crossOrigin: "anonymous",
          beforeLoad(script) {
            script.type = "module";
          },
        });
      }
      signal.throwIfAborted();
      const loadedUi = window.__okouClerkUI;
      if (
        !loadedUi ||
        typeof loadedUi.ClerkUI !== "function" ||
        loadedUi.version !== CLERK_UI_VERSION
      ) {
        throw new Error(
          "Clerk UI entry is missing or has an incompatible version",
        );
      }
      resolveClerkUI(loadedUi.ClerkUI);
      return loadedUi;
    })();
    return loadPromise;
  };
}

function matchesEarlyLoadOptions(
  early: EarlyClerkBootstrap["loadOptions"],
  current: ClerkRuntimeLoadOptions,
): boolean {
  return (
    early.afterSignOutUrl === current.afterSignOutUrl &&
    early.signInUrl === current.signInUrl &&
    early.signUpUrl === current.signUpUrl
  );
}

function adoptEarlyClerkRuntime(
  clerk: BrowserClerk,
  options: ClerkRuntimeOptions,
  signal: AbortSignal,
): ClerkBrowserRuntime | null {
  const bootstrap = window.__okouClerkBootstrap;
  if (!bootstrap?.loaded || bootstrap.clerk !== clerk) {
    return null;
  }
  if (
    bootstrap.publishableKey !== options.publishableKey ||
    !matchesEarlyLoadOptions(bootstrap.loadOptions, options.loadOptions)
  ) {
    throw new Error("Early Clerk bootstrap configuration mismatch");
  }

  const loaded = bootstrap.loaded;
  bootstrap.loaded = undefined;

  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(
      bootstrap.resolveClerkUI,
      bootstrap.uiLoaded,
      signal,
    ),
    loaded,
  };
}

/**
 * `signal` owns the optional UI handle handed to Clerk core. Clerk keeps that
 * promise for the lifetime of the shared browser runtime, so only the app
 * root may abort it; route and command signals must not.
 */
export async function startClerkBrowserRuntime(
  options: ClerkRuntimeOptions,
  signal: AbortSignal,
): Promise<ClerkBrowserRuntime> {
  await loadClerkJSScript({
    __internal_clerkJSVersion: CLERK_JS_VERSION,
    publishableKey: options.publishableKey,
  });
  const clerk: unknown = Reflect.get(globalThis, "Clerk");
  if (!isBrowserClerk(clerk)) {
    throw new Error("Clerk browser script did not expose a valid runtime");
  }
  signal.throwIfAborted();
  const earlyRuntime = adoptEarlyClerkRuntime(clerk, options, signal);
  if (earlyRuntime) {
    return earlyRuntime;
  }

  // Clerk accepts the UI constructor as a promise, so core initialization does
  // not wait for a download that most routes never need.
  const clerkUI = createDeferredPromise<ClerkUIConstructor>(signal);
  const loaded = clerk.load({
    ...options.loadOptions,
    routerPush: clerkRouterPush,
    routerReplace: clerkRouterReplace,
    ui: { ClerkUI: clerkUI.promise },
  });
  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(clerkUI.resolve, undefined, signal),
    loaded,
  };
}
