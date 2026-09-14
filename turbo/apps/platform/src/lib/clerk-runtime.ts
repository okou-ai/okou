import { loadScript } from "@clerk/shared/loadScript";
import type { BrowserClerk } from "@clerk/shared/types";
import type { ui } from "@clerk/ui";
import { CLERK_UI_VERSION } from "./clerk-versions.ts";

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

type ClerkBootstrap = NonNullable<Window["__okouClerkBootstrap"]>;
type ResolveClerkUI = ClerkBootstrap["resolveClerkUI"];

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
): () => Promise<typeof ui> {
  let loadPromise: Promise<typeof ui> | undefined;
  return () => {
    loadPromise ??= (async () => {
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

/** Read the browser runtime initialized by the inline page bootstrap. */
export async function readClerkBrowserRuntime(): Promise<ClerkBrowserRuntime> {
  const bootstrap = window.__okouClerkBootstrap;
  if (!bootstrap) {
    throw new Error("Clerk bootstrap is unavailable");
  }

  const { clerk, loaded } = await bootstrap.runtime;
  if (!isBrowserClerk(clerk)) {
    throw new Error("Clerk bootstrap did not expose a valid runtime");
  }

  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(
      bootstrap.resolveClerkUI,
      bootstrap.uiLoaded,
    ),
    loaded,
  };
}
