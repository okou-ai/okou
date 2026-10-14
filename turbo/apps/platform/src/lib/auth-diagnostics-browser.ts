import type { AuthDiagnosticContext } from "./auth-diagnostics.ts";

/** Installed only by browser owners, never imported into the Worker graph.
 * The shared observer invokes this inside its best-effort collection boundary,
 * so each record sees current visibility without letting DOM/UA errors escape.
 */
export function createBrowserAuthDiagnosticContext(
  context?: AuthDiagnosticContext,
): AuthDiagnosticContext {
  return {
    ...context,
    readBrowserContext: () => {
      const iosLike =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone =
        Reflect.get(navigator, "standalone") === true ||
        window.matchMedia("(display-mode: standalone)").matches;
      return {
        visibility: document.visibilityState,
        iosLike,
        displayMode: standalone ? "standalone" : "browser",
      };
    },
  };
}
