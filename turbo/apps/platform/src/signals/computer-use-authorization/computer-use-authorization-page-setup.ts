import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ComputerUseAuthorizationPage } from "../../views/computer-use-authorization/computer-use-authorization-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";

export const setupComputerUseAuthorizationPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ComputerUseAuthorizationPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.authorization.computerUse.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
