import { command, computed, state } from "ccstate";
import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/client/browser";

import { accept } from "../../lib/accept.ts";
import { pathParams$ } from "../route.ts";
import { apiClient$ } from "../api-client.ts";

const browserAuthorizationReload$ = state(0);

const browserAuthorizationRequestToken$ = computed((get) => {
  const token = get(pathParams$)?.requestToken;
  return typeof token === "string" ? token : null;
});

export const browserAuthorizationRequest$ = computed(async (get) => {
  get(browserAuthorizationReload$);
  const requestToken = get(browserAuthorizationRequestToken$);
  if (!requestToken) {
    return null;
  }
  const client = get(apiClient$)(browserAuthorizationRequestsContract);
  const result = await accept(client.get({ params: { requestToken } }), [200]);
  return result.body;
});

export const applyBrowserAuthorizationRequest$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const requestToken = get(browserAuthorizationRequestToken$);
    if (!requestToken) {
      throw new Error("Cloud browser authorization request token is missing");
    }
    const client = get(apiClient$)(browserAuthorizationRequestsContract);
    const result = await accept(
      client.apply({
        params: { requestToken },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(browserAuthorizationReload$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);
