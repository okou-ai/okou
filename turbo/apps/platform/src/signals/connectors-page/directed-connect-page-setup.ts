import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { DirectedConnectPage } from "../../views/okou-page/directed-connect-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { initializeDirectedConnectAccounts$ } from "./directed-connect-slug.ts";

export const setupDirectedConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const connectorSlug =
      typeof params?.connectorSlug === "string" ? params.connectorSlug : "";

    await set(initializeDirectedConnectAccounts$, signal);
    signal.throwIfAborted();
    set(updatePage$, createElement(DirectedConnectPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.connectors.directed.connectDocumentTitle;
        },
        { connector: connectorSlug },
      ),
    );
    await set(hideAppSkeleton$, signal);
  },
);
