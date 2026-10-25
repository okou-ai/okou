import { command } from "ccstate";
import { createElement } from "react";
import { ActivityDetailPage } from "../../views/okou-page/activity-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";
import { currentRunId$ } from "./activity-signals.ts";

export const setupActivityDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(currentRunId$);
    set(
      updatePage$,
      createElement(ActivityDetailPage, { key: runId }),
      "sidebar",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.activity.documentTitle;
      }),
    );

    await set(hideAppSkeleton$, signal);
  },
);
