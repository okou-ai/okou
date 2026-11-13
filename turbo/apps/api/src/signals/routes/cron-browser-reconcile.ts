import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { joinAll } from "../utils";
import { reconcileBrowserUserActions$ } from "../services/browser-user-actions.service";
import { reconcileSharedBrowsers$ } from "../services/browser-shared-reconcile.service";
import { cleanupBrowserScreenshots$ } from "../services/browser-screenshot-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileBrowsersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const [userActions, shared] = await joinAll([
      set(reconcileBrowserUserActions$, 20, signal),
      set(reconcileSharedBrowsers$, null, signal),
    ]);
    signal.throwIfAborted();
    const screenshots = await set(cleanupBrowserScreenshots$, 20, signal);
    signal.throwIfAborted();
    const body = {
      checked: userActions + shared.checked + screenshots.checked,
      stopped: shared.stopped + screenshots.cleaned,
      errors: shared.errors + screenshots.errors,
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
