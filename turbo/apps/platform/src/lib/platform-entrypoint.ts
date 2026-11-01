import "./preview-bypass-cookie-bootstrap.ts";
import "./accept-browser.ts";
import { browserUpgradeRequired } from "./browser-support.ts";
import { initSentry } from "./sentry.ts";
import { captureFirstSkeletonPaint, initPostHog } from "./posthog.ts";
import "../polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { bootstrap$ } from "../signals/bootstrap.ts";
import { captureDiscordApprovalFragment$ } from "../signals/okou-page/discord-oauth-approval.ts";
import { captureLandingFilePreview$ } from "../signals/prompt-page/landing-file-preview.ts";
import { receiveLandingFileTransfer } from "../signals/prompt-page/landing-file-transfer.ts";
import { ASSISTANT_NAME } from "../signals/branding.ts";
import { detach, Reason } from "../signals/utils.ts";
import { setupRouter } from "../views/main.tsx";
import { renderUnsupportedBrowserPage } from "../views/unsupported-browser-page.tsx";

// (no-op Platform release marker refreshed for production delivery at 2026-10-30T11:35:01+08:00)

function startApplication(
  rootSignal: AbortSignal,
  store: ReturnType<typeof createStore>,
): void {
  rootSignal.throwIfAborted();

  // Initialize Sentry before bootstrap so errors during startup are captured
  initSentry();
  initPostHog();
  captureFirstSkeletonPaint();

  async function main() {
    await store.set(
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
  }

  detach(main(), Reason.Entrance, "main");
}

export function startPlatformEntrypoint(): void {
  const rootSignal = window._okou?.rootSignal;
  if (!rootSignal) {
    throw new Error("Platform lifecycle was not initialized");
  }
  rootSignal.throwIfAborted();
  if (
    new URLSearchParams(window.location.hash.slice(1)).has(
      "landingFileTransfer",
    )
  ) {
    detach(
      receiveLandingFileTransfer(rootSignal),
      Reason.Entrance,
      "landing file transfer",
    );
    return;
  }
  // The transfer uses opener only until the normal auth/onboarding navigation.
  if (new URLSearchParams(window.location.search).has("landingFiles")) {
    window.opener = null;
  }
  const store = createStore();
  store.set(captureLandingFilePreview$, rootSignal);
  store.set(captureDiscordApprovalFragment$, rootSignal);
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
    startApplication(rootSignal, store);
  }
}
