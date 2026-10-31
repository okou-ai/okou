import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/client/browser";
import { command, computed, state } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { runChatActionCallback$ } from "./action-callback.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
} from "./chat-action-context.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface BrowserAuthorizationDescriptor {
  readonly requestToken: string;
  readonly originalUrl: string;
}

export function parseBrowserAuthorizationUrl(
  value: string,
): BrowserAuthorizationDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  const requestToken = url?.pathname.match(
    /^\/browser\/authorize\/([^/]+)$/u,
  )?.[1];
  return requestToken ? { requestToken, originalUrl: value } : null;
}

function createBrowserAuthorizationSignals(
  descriptor: BrowserAuthorizationDescriptor,
  context: ChatActionContext,
) {
  const revision$ = state(0);
  const request$ = computed(async (get) => {
    get(revision$);
    const result = await accept(
      get(apiClient$)(browserAuthorizationRequestsContract).get({
        params: { requestToken: descriptor.requestToken },
      }),
      [200, 403, 404, 410],
    );
    return result.status === 200 &&
      chatActionIdMatches(result.body.chatThreadId, context.threadId)
      ? result.body
      : null;
  });
  const refresh$ = command(({ set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
  });
  const allow$ = command(async ({ get, set }, signal: AbortSignal) => {
    const request = await get(request$);
    signal.throwIfAborted();
    if (!request) {
      throw new Error(
        "Cloud browser authorization is unavailable in this chat",
      );
    }
    await accept(
      get(apiClient$)(browserAuthorizationRequestsContract).apply({
        params: { requestToken: descriptor.requestToken },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(
      runChatActionCallback$,
      {
        ...context,
        callbackPrompt: i18n.t(($) => {
          return $.authorization.browser.callbackPrompt;
        }),
        // The request identifies its single continuation across tabs.
        callbackIds: {
          clientEventId: request.id,
          chatThreadSortEventId: request.id,
        },
      },
      signal,
    );
  });
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: "desktopShellAuthorizationChanged",
        loopCommand$: invalidate$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  });
  return { ...descriptor, request$, allow$, subscribe$ };
}

export type BrowserAuthorizationSignals = ReturnType<
  typeof createBrowserAuthorizationSignals
>;

export function createBrowserAuthorizationCardSignalsRegistry(
  context: ChatActionContext,
) {
  return createCardSignalsRegistry(
    (descriptor: BrowserAuthorizationDescriptor) => {
      return descriptor.requestToken;
    },
    (descriptor) => {
      return createBrowserAuthorizationSignals(descriptor, context);
    },
    (signals) => {
      return signals.subscribe$;
    },
  );
}
