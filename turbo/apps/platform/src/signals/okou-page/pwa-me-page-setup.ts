import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { NotFoundPage } from "../../views/not-found-page.tsx";
import { PwaMePage } from "../../views/okou-page/pwa-me-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { initializePwaMePage$ } from "./pwa-me-page.ts";
import { pwaNavigationEnabled$ } from "./pwa-navigation.ts";

export const setupPwaMePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(pwaNavigationEnabled$)) {
      set(updatePage$, createElement(NotFoundPage));
      await set(hideAppSkeleton$, signal);
      return;
    }
    set(updatePage$, createElement(PwaMePage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.appShell.pwaNavigation.me;
      }),
    );
    await set(hideAppSkeleton$, signal);
    await set(initializePwaMePage$, signal);
  },
);
