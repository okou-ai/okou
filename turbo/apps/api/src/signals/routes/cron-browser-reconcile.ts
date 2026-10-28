import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileBrowsers$ } from "../services/browser.service";
import { reconcileSharedBrowsers$ } from "../services/browser-shared-reconcile.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileBrowsersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const legacy = await set(reconcileBrowsers$, signal);
    signal.throwIfAborted();
    const shared = await set(reconcileSharedBrowsers$, null, signal);
    signal.throwIfAborted();
    const body = {
      ...legacy,
      checked: legacy.checked + shared.checked,
      stopped: legacy.stopped + shared.stopped,
      errors: legacy.errors + shared.errors,
    };
    return { status: 200 as const, body };
  },
);

export const cronBrowserReconcileRoutes: readonly RouteEntry[] = [
  {
    route: cronBrowserReconcileContract.reconcile,
    handler: reconcileBrowsersRoute$,
  },
];
