import { command } from "ccstate";
import { createElement } from "react";
import { FeedPage } from "../../views/feed-page/feed-page.tsx";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { enterAgentSuggestions$ } from "../okou-page/agent-suggestion-session.ts";

export const setupFeedPage$ = command(async ({ set }, signal: AbortSignal) => {
  // Each visit reads one snapshot. The page renders while it loads.
  detach(
    set(enterAgentSuggestions$, signal),
    Reason.Daemon,
    "feed suggestions",
  );
  set(updatePage$, createElement(FeedPage), "sidebar");
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.feed.title;
    }),
  );
  await set(hideAppSkeleton$, signal);
});
