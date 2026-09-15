import "./preview-bypass-cookie-bootstrap.ts";
import "./accept-browser.ts";
import { browserUpgradeRequired } from "./browser-support.ts";
import { initGoogleAds } from "./google-ads.ts";
import { initSentry } from "./sentry.ts";
import { captureFirstSkeletonPaint, initPostHog } from "./posthog.ts";
import { initPlausible } from "./plausible.ts";
import { setupVisualViewportKeyboardState } from "./visual-viewport-keyboard.ts";
import "../polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { bootstrap$ } from "../signals/bootstrap.ts";
import { ASSISTANT_NAME } from "../signals/branding.ts";
import { detach, Reason, resetSignal } from "../signals/utils.ts";
import { setupRouter } from "../views/main.tsx";
import { renderUnsupportedBrowserPage } from "../views/unsupported-browser-page.tsx";

// (no-op Platform release marker refreshed again on 2026-07-31)

function startApplication(rootSignal: AbortSignal): void {
  rootSignal.throwIfAborted();
  const resetViewportSettleSignal$ = resetSignal();

  // Initialize Sentry before bootstrap so errors during startup are captured
  initSentry();
  initPostHog();
  captureFirstSkeletonPaint();

  async function main() {
    const store = createStore();
    detach(initPlausible(rootSignal), Reason.Entrance, "initPlausible");
    setupVisualViewportKeyboardState(rootSignal, () => {
      return store.set(resetViewportSettleSignal$, rootSignal);
    });

    const runtime = store.set(
      bootstrap$,
      __OKOU_APP_VERSION__,
      () => {
        setupRouter(store, (el) => {
          const rootEl = document.getElementById("root");
          if (!rootEl) {
            throw new Error("can't find root el to load whole app");
          }
          const root = createRoot(rootEl);
          root.render(el);
          rootSignal.addEventListener("abort", () => {
            root.unmount();
          });
        });
      },
      rootSignal,
    );
    detach(
      runtime.sharedDatabaseDaemon,
      Reason.Daemon,
      "shared database bridge",
    );
    detach(
      runtime.authenticatedRealtimeDaemon,
      Reason.Daemon,
      "app realtime subscriptions",
    );
    detach(runtime.clerkIdentityDaemon, Reason.Daemon, "clerk identity");
    await runtime.ready;
  }

  detach(main(), Reason.Entrance, "main");
}

export function startPlatformEntrypoint(): void {
  const rootSignal = window._okou?.rootSignal;
  if (!rootSignal) {
    throw new Error("Platform lifecycle was not initialized");
  }
  rootSignal.throwIfAborted();
  window.__appBootstrapModuleReady = performance.now();
  const browserUpgrade = browserUpgradeRequired();
  if (browserUpgrade) {
    const rootElement = document.getElementById("root");
    if (!rootElement) {
      throw new Error("can't find root el to render unsupported browser page");
    }
    renderUnsupportedBrowserPage(
      rootElement,
      ASSISTANT_NAME,
      browserUpgrade,
      rootSignal,
    );
  } else {
    startApplication(rootSignal);
  }
  initGoogleAds();
}
