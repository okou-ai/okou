import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { SlackConnectPage } from "../../views/okou-page/slack-connect-page.tsx";
import { initSlackConnectPage$ } from "./slack-connect-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSlackConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(initSlackConnectPage$, signal);
    set(updatePage$, createElement(SlackConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.slack.connectTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
