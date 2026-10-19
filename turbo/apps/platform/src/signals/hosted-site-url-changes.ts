import { command, computed, state } from "ccstate";
import { pageVersion$ } from "./page-signal.ts";

// Confirmed renames belong to the current page, so all open preview surfaces
// update together without retaining a cross-page URL cache.
const changesState$ = computed((get) => {
  get(pageVersion$);
  return state<Readonly<Record<string, string>>>({});
});
export const hostedSiteUrlChanges$ = computed((get) => {
  return get(get(changesState$));
});

export function currentHostedSiteUrl(
  url: string,
  changes: Readonly<Record<string, string>>,
): string {
  const parsed = new URL(url, location.origin);
  const target = changes[parsed.origin];
  if (!target) {
    return url;
  }
  const renamed = new URL(target);
  renamed.pathname = parsed.pathname;
  renamed.search = parsed.search;
  renamed.hash = parsed.hash;
  return renamed.href;
}

export const recordHostedSiteUrlChange$ = command(
  ({ get, set }, previousUrl: string, nextUrl: string) => {
    const previous = new URL(previousUrl).origin;
    const next = new URL(nextUrl).origin;
    const changes = get(hostedSiteUrlChanges$);
    set(get(changesState$), {
      ...Object.fromEntries(
        Object.entries(changes).map(([source, target]) => {
          return [source, target === previous ? next : target];
        }),
      ),
      [previous]: next,
    });
  },
);
