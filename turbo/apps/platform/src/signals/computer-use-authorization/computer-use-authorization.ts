import { command, computed, state } from "ccstate";
import { computerUseAuthorizationRequestsContract } from "@okouai/api-contracts/client/computer-use";
import type { ComputerUseHost } from "@okouai/api-contracts/contracts/computer-use";
import { accept } from "../../lib/accept.ts";
import {
  authorizationChatCallback,
  runAuthorizationChatCallback$,
} from "../chat-page/action-callback.ts";
import { searchParams$, pathParams$ } from "../route.ts";
import { apiClient$ } from "../api-client.ts";

const computerUseAuthorizationReload$ = state(0);

const computerUseAuthorizationRequestToken$ = computed((get) => {
  const params = get(pathParams$);
  const token = params?.requestToken;
  return typeof token === "string" ? token : null;
});

const authorizationOriginalUrl$ = computed((get) => {
  return `/computer-use/authorize/${get(computerUseAuthorizationRequestToken$)}?${get(searchParams$).toString()}`;
});

export const computerUseAuthorizationRequest$ = computed(async (get) => {
  get(computerUseAuthorizationReload$);
  const requestToken = get(computerUseAuthorizationRequestToken$);
  if (!requestToken) {
    return null;
  }

  const client = get(apiClient$)(computerUseAuthorizationRequestsContract);
  const result = await accept(client.get({ params: { requestToken } }), [200]);
  authorizationChatCallback(
    get(authorizationOriginalUrl$),
    result.body.chatThreadId ?? "",
  );
  return result.body;
});

export const applyComputerUseAuthorizationRequest$ = command(
  async (
    { get, set },
    host: Pick<ComputerUseHost, "id">,
    signal: AbortSignal,
  ) => {
    const requestToken = get(computerUseAuthorizationRequestToken$);
    if (!requestToken) {
      throw new Error("Computer Use authorization request token is missing");
    }

    const request = await get(computerUseAuthorizationRequest$);
    signal.throwIfAborted();
    if (!request) {
      throw new Error("Authorization request is unavailable");
    }
    const client = get(apiClient$)(computerUseAuthorizationRequestsContract);
    if (!request.completedAt) {
      await accept(
        client.apply({
          params: { requestToken },
          body: { computerUseHostId: host.id },
          fetchOptions: { signal },
        }),
        [200],
      );
    }
    set(computerUseAuthorizationReload$, (value) => {
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
    set(computerUseAuthorizationReload$, (prev) => {
      return prev + 1;
    });
    return {
      ...request,
      computerUseHostId: request.completedAt
        ? request.computerUseHostId
        : host.id,
    };
  },
);
