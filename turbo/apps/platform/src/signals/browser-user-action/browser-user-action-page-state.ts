import { command, computed, state } from "ccstate";

import {
  parseBrowserUserActionUrl,
  type BrowserUserActionSignals,
} from "../chat-page/browser-user-action-block.ts";
import { pathParams$, searchParams$ } from "../route.ts";

const internalBrowserUserActionPageSignals$ =
  state<BrowserUserActionSignals | null>(null);

export const browserUserActionPageDescriptor$ = computed((get) => {
  const requestToken = String(get(pathParams$)?.browserActionToken ?? "");
  const query = get(searchParams$).toString();
  const result = parseBrowserUserActionUrl(
    `/browser/actions/${encodeURIComponent(requestToken)}${query ? `?${query}` : ""}`,
  );
  return result.status === "valid" ? result.descriptor : null;
});

export const browserUserActionPageSignals$ = computed((get) => {
  return get(internalBrowserUserActionPageSignals$);
});

export const setBrowserUserActionPageSignals$ = command(
  ({ set }, signals: BrowserUserActionSignals | null): void => {
    set(internalBrowserUserActionPageSignals$, signals);
  },
);
