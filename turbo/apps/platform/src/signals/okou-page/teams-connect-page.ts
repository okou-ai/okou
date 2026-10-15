import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { TeamsConnectPage } from "../../views/okou-page/teams-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { watchTeamsConnection$ } from "./teams.ts";

export const setupTeamsConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(TeamsConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.teams.connectTitle;
      }),
    );

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(watchTeamsConnection$, signal),
    ]);
  },
);
