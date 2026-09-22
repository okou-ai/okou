import { computed } from "ccstate";

import {
  createBrowserUserActionSignals,
  parseBrowserUserActionUrl,
} from "../chat-page/browser-user-action-block.ts";
import { pathParams$, searchParams$ } from "../route.ts";

export const browserUserActionPageDescriptor$ = computed((get) => {
  const requestToken = String(get(pathParams$)?.browserActionToken ?? "");
  const query = get(searchParams$).toString();
  const result = parseBrowserUserActionUrl(
    `/browser/actions/${encodeURIComponent(requestToken)}${query ? `?${query}` : ""}`,
  );
  return result.status === "valid" ? result.descriptor : null;
});

export const browserUserActionPageSignals$ = computed((get) => {
  const descriptor = get(browserUserActionPageDescriptor$);
  return descriptor ? createBrowserUserActionSignals(descriptor) : null;
});
