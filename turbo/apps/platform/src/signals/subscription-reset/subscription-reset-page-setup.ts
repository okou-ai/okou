import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { SubscriptionResetPage } from "../../views/subscription-reset/subscription-reset-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { subscriptionResetPageSignals$ } from "./subscription-reset-page-state.ts";

export const setupSubscriptionResetPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const signals = get(subscriptionResetPageSignals$);
    set(
      updatePage$,
      createElement(SubscriptionResetPage, {
        key: signals?.originalUrl ?? "invalid-subscription-reset",
      }),
      "standalone",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.subscriptionReset.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
