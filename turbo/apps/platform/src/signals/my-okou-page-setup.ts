import { command } from "ccstate";
import { createElement } from "react";
import { MyOkouPage } from "../views/my-okou-page.tsx";
import { myOkouSignals$ } from "./my-okou.ts";
import { singleAgentEnabled$ } from "./single-agent.ts";
import { updatePage$ } from "./react-router.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { detachedNavigateTo$ } from "./route.ts";
import { i18n } from "../i18n/index.ts";

export const setupMyOkouPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(singleAgentEnabled$)) {
      set(detachedNavigateTo$, "/agents", { replace: true });
      return;
    }
    const signals = await get(myOkouSignals$);
    signal.throwIfAborted();
    set(signals.retry$);
    set(signals.watch$, signal);
    window.addEventListener(
      "beforeunload",
      (event) => {
        const draft = get(signals.draft$);
        if (draft && draft.content !== draft.savedContent) {
          // Only the document unload can destroy this tab's retained drafts.
          event.preventDefault();
        }
      },
      { signal },
    );
    set(updatePage$, createElement(MyOkouPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.myOkou.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
