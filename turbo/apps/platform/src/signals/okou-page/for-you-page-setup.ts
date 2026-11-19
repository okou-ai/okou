import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ForYouPage } from "../../views/okou-page/for-you-page.tsx";
import { defaultAgentId$ } from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { resetProjectUi$ } from "../projects/project-ui.ts";
import { updatePage$ } from "../react-router.ts";
import { navigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { detach, Reason } from "../utils.ts";
import { setupForYouPageKeyboardShortcuts$ } from "./agent-chat-keyboard.ts";
import {
  enterSuggestionSession$,
  suggestionsEnabled$,
} from "./agent-suggestion-session.ts";
import { setupForYouPagination$ } from "./for-you.ts";

export const setupForYouPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(suggestionsEnabled$))) {
      await set(navigateTo$, ROUTES.home, { replace: true }, signal);
      return;
    }
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    set(setupForYouPagination$, signal);
    set(setupForYouPageKeyboardShortcuts$, signal);
    set(resetProjectUi$);
    set(setChatAgentId$, agentId);
    const loading = set(enterSuggestionSession$, signal);
    set(updatePage$, createElement(ForYouPage), "sidebar");
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
