import { command } from "ccstate";
import { createElement } from "react";
import { IdeationPage } from "../../views/okou-page/ideation-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupIdeationPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(IdeationPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.ideation.title;
        },
        { ns: "common" },
      ),
    );

    await set(hideAppSkeleton$, signal);
  },
);
