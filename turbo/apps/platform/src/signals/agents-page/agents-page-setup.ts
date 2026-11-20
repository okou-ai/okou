import { singleAgentEnabled$ } from "../single-agent.ts";
import { MORNING_BRIEF_PREFERENCES_FOCUS } from "@okouai/api-contracts/validators/morning-brief-preference";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { AgentsPageTabs } from "../../views/agents-page/agents-page-tabs.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupAgentsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await get(singleAgentEnabled$)) {
      const params = get(searchParams$);
      const morningBrief =
        params.get("settings") === "preference" &&
        params.get("focus") === MORNING_BRIEF_PREFERENCES_FOCUS;
      set(detachedNavigateTo$, "/", {
        searchParams: morningBrief
          ? new URLSearchParams({
              settings: "preference",
              focus: MORNING_BRIEF_PREFERENCES_FOCUS,
            })
          : new URLSearchParams({ settings: "my-okou" }),
        replace: true,
      });
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
