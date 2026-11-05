import { singleAgentEnabled$ } from "../single-agent.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { AgentsPageTabs } from "../../views/agents-page/agents-page-tabs.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupAgentsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(singleAgentEnabled$)) {
      set(detachedNavigateTo$, "/my-okou", { replace: true });
      return;
    }
    set(updatePage$, createElement(AgentsPageTabs), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.list.documentTitle;
        },
        { ns: "agents" },
      ),
    );
    await set(hideAppSkeleton$, signal);
  },
);
