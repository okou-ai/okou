import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { GithubConnectPage } from "../../views/okou-page/github-connect-page.tsx";

export const setupGithubConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(GithubConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.github.connectTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
