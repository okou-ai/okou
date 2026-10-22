import { command, computed, state } from "ccstate";
import { pageVersion$ } from "./page-signal.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "./hosted-site-url-changes.ts";

const changesState$ = computed((get) => {
  get(pageVersion$);
  return state<Readonly<Record<string, string | null>>>({});
});

export const hostedSiteVisibilityChanges$ = computed((get) => {
  return get(get(changesState$));
});

/** Invalidate previews after observing a new persisted policy revision. */
export const recordHostedSiteVisibilityChange$ = command(
  (
    { get, set },
    change: { readonly url: string; readonly revision: string | null },
  ) => {
    const currentUrl = currentHostedSiteUrl(
      change.url,
      get(hostedSiteUrlChanges$),
    );
    set(get(changesState$), {
      ...get(hostedSiteVisibilityChanges$),
      [new URL(change.url).origin]: change.revision,
      [new URL(currentUrl).origin]: change.revision,
    });
  },
);
