import { command, state } from "ccstate";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "./hosted-site-url-changes.ts";

export const hostedSiteVisibilityChanges$ = state<
  ReadonlyMap<string, string | null>
>(new Map());

/** Invalidate previews after observing a new persisted policy revision. */
export const recordHostedSiteVisibilityChange$ = command(
  (
    { get, set },
    change: { readonly url: string; readonly revision: string | null },
  ) => {
    const revisions = new Map(get(hostedSiteVisibilityChanges$));
    const currentUrl = currentHostedSiteUrl(
      change.url,
      get(hostedSiteUrlChanges$),
    );
    for (const url of [change.url, currentUrl]) {
      revisions.set(new URL(url).origin, change.revision);
    }
    set(hostedSiteVisibilityChanges$, revisions);
  },
);
