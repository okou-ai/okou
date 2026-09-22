import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { BrowserUserActionPage } from "../../views/browser-user-action/browser-user-action-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { createBrowserUserActionSignals } from "../chat-page/browser-user-action-block.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  browserUserActionPageDescriptor$,
  setBrowserUserActionPageSignals$,
} from "./browser-user-action-page-state.ts";

export const setupBrowserUserActionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const descriptor = get(browserUserActionPageDescriptor$);
    set(
      setBrowserUserActionPageSignals$,
      descriptor ? createBrowserUserActionSignals(descriptor) : null,
    );
    set(updatePage$, createElement(BrowserUserActionPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.browserInput.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
