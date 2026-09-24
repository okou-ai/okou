import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { BrowserUserActionPage } from "../../views/browser-user-action/browser-user-action-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import {
  browserUserActionPageDescriptor$,
  browserUserActionPageSignals$,
} from "./browser-user-action-page-state.ts";

export const setupBrowserUserActionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const descriptor = get(browserUserActionPageDescriptor$);
    set(
      updatePage$,
      createElement(BrowserUserActionPage, {
        key: descriptor?.originalUrl ?? "invalid-browser-user-action",
      }),
      "standalone",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.browserAction.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    const signals = get(browserUserActionPageSignals$);
    if (signals) {
      detach(set(signals.startStandaloneEntry$, signal), Reason.Entrance);
    }
  },
);
