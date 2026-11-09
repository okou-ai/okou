import { command, computed, state } from "ccstate";
import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/client/browser";

import { accept } from "../../lib/accept.ts";
import {
  authorizationChatCallback,
  runAuthorizationChatCallback$,
} from "../chat-page/action-callback.ts";
import { searchParams$, pathParams$ } from "../route.ts";
import { apiClient$ } from "../api-client.ts";

const browserAuthorizationReload$ = state(0);

const browserAuthorizationRequestToken$ = computed((get) => {
  const token = get(pathParams$)?.requestToken;
  return typeof token === "string" ? token : null;
});

const authorizationOriginalUrl$ = computed((get) => {
  return `/browser/authorize/${get(browserAuthorizationRequestToken$)}?${get(searchParams$).toString()}`;
});

export const browserAuthorizationRequest$ = computed(async (get) => {
  get(browserAuthorizationReload$);
  const requestToken = get(browserAuthorizationRequestToken$);
  if (!requestToken) {
    return null;
  }
  const client = get(apiClient$)(browserAuthorizationRequestsContract);
  const result = await accept(client.get({ params: { requestToken } }), [200]);
  authorizationChatCallback(
    get(authorizationOriginalUrl$),
    result.body.chatThreadId ?? "",
  );
  return result.body;
});

export const applyBrowserAuthorizationRequest$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const requestToken = get(browserAuthorizationRequestToken$);
    if (!requestToken) {
      throw new Error("Cloud browser authorization request token is missing");
    }
    const request = await get(browserAuthorizationRequest$);
    signal.throwIfAborted();
    if (!request) {
      throw new Error("Authorization request is unavailable");
    }
    const client = get(apiClient$)(browserAuthorizationRequestsContract);
    if (!request.completedAt) {
      await accept(
        client.apply({
          params: { requestToken },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
      );
    }
    set(browserAuthorizationReload$, (value) => {
      return value + 1;
    });
    await set(
      runAuthorizationChatCallback$,
      {
        originalUrl: get(authorizationOriginalUrl$),
        chatThreadId: request.chatThreadId ?? "",
        authorizationId: request.id,
      },
      signal,
    );
    set(browserAuthorizationReload$, (value) => {
      return value + 1;
    });
    return request;
  },
);
