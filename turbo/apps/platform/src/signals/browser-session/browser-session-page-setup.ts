import { command } from "ccstate";
import { createElement } from "react";

import { BrowserSessionPage } from "../../views/browser-session/browser-session-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { parseBrowserSessionUrl } from "../chat-page/browser-session-block.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import {
  createBrowserSessionPageSignals,
  setBrowserSessionPageSignals$,
} from "./browser-session-page-state.ts";
import { i18n } from "../../i18n/index.ts";

export const setupBrowserSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = String(get(pathParams$)?.browserThreadId ?? "");
    const descriptor = parseBrowserSessionUrl(`/browsers/${threadId}`);
    const signals = descriptor
      ? createBrowserSessionPageSignals(descriptor.threadId)
      : null;
    set(setBrowserSessionPageSignals$, signals);
    if (signals) {
      set(signals.browser.subscribe$, signal);
    }
    set(updatePage$, createElement(BrowserSessionPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.browserSession.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
