import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ForYouPage } from "../../views/okou-page/for-you-page.tsx";

import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { pageVersion$ } from "../page-signal.ts";
import { resetProjectUi$ } from "../projects/project-ui.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { setupForYouPageKeyboardShortcuts$ } from "./chat-keyboard.ts";
import { enterSuggestionSession$ } from "./agent-suggestion-session.ts";
import { setupForYouPagination$ } from "./for-you.ts";

export const setupForYouPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(setupForYouPagination$, signal);
    set(setupForYouPageKeyboardShortcuts$, signal);
    set(resetProjectUi$);
    const loading = set(enterSuggestionSession$, signal);
    // Retain resolved counts only within this visit.
    set(
      updatePage$,
      createElement(ForYouPage, { key: get(pageVersion$) }),
      "sidebar",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.agentSuggestions.forYou.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    // The page's loadable owns loading, failure and retry instead of blocking
    // the workspace shell on the suggestion request.
    detach(loading, Reason.Daemon, "for you suggestions");
  },
);
