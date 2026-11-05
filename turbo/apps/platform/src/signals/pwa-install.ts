import { command, computed, state } from "ccstate";
import { localStorageSignals } from "./external/local-storage.ts";
import { refreshChatListLayout$ } from "./chat-page/chat-list-layout.ts";
import { isStandaloneMode } from "./okou-page/settings/connectors.ts";

/**
 * Detect Safari on iPhone or iPad.
 *
 * iPhone/iPod: UA contains "iPhone" or "iPod" and "Safari" (not CriOS etc.).
 * iPad (pre-13): UA contains "iPad".
 * iPadOS 13+: reports as desktop Macintosh UA, but iPad has multi-touch
 * (>1 maxTouchPoints) whereas macOS trackpads report 0-1.
 */
function detectIOSSafari(): boolean {
  const ua = navigator.userAgent;
  if (!/Safari/.test(ua) || /CriOS|FxiOS|OPiOS|EdgiOS/.test(ua)) {
    return false;
  }
  if (/iPhone|iPod/.test(ua)) {
    return true;
  }
  if (/iPad/.test(ua)) {
    return true;
  }
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

const iosModalOpen$ = state(false);

const INSTALL_BANNER_DISMISSED_KEY = "install-banner-dismissed";

const { get$: dismissedRaw$, set$: setDismissed$ } = localStorageSignals(
  INSTALL_BANNER_DISMISSED_KEY,
);

export const installBannerVisible$ = computed((get) => {
  if (isStandaloneMode()) {
    return false;
  }
  if (get(dismissedRaw$) !== null) {
    return false;
  }
  return detectIOSSafari();
});

export const iosInstallModalOpen$ = computed((get) => {
  return get(iosModalOpen$);
});

export const triggerInstall$ = command(({ set }, _signal?: AbortSignal) => {
  if (detectIOSSafari()) {
    set(iosModalOpen$, true);
  }
});

export const closeIosInstallModal$ = command(({ set }) => {
  set(iosModalOpen$, false);
});

export const dismissInstallBanner$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setDismissed$, "1");
    // The banner sits above the mobile chat list.
    await set(refreshChatListLayout$, signal);
  },
);
