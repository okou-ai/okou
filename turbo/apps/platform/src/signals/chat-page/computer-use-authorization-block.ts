import { command, computed, state } from "ccstate";
import { timeout } from "signal-timers";
import { computerUseAuthorizationRequestsContract } from "@okouai/api-contracts/client/computer-use";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { detach, Reason } from "../utils.ts";
import {
  authorizationChatCallback,
  runAuthorizationChatCallback$,
} from "./action-callback.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { chatActionIdMatches } from "./chat-action-context.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface ComputerUseAuthorizationDescriptor {
  requestToken: string;
  originalUrl: string;
  href: string;
}

export function parseComputerUseAuthorizationUrl(
  value: string,
): ComputerUseAuthorizationDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }

  const match = url.pathname.match(/^\/computer-use\/authorize\/([^/]+)$/);
  const requestToken = match?.[1];
  if (!requestToken) {
    return null;
  }

  const href = `/computer-use/authorize/${encodeURIComponent(requestToken)}${url.search}`;
  return {
    requestToken,
    originalUrl: value,
    href,
  };
}

function createComputerUseAuthorizationSignals(
  descriptor: ComputerUseAuthorizationDescriptor,
  threadId: string,
) {
  const revision$ = state(0);
  const expired$ = state(false);
  const chosenHostId$ = state<string | null>(null);
  const request$ = computed(async (get) => {
    get(revision$);
    if (get(expired$)) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(computerUseAuthorizationRequestsContract).get({
        params: { requestToken: descriptor.requestToken },
      }),
      [200, 403, 404, 410],
    );
    if (result.status === 200 && result.body.chatThreadId) {
      authorizationChatCallback(
        descriptor.originalUrl,
        result.body.chatThreadId,
      );
    }
    return result.status === 200 &&
      result.body.source === "chat" &&
      result.body.chatThreadId !== null &&
      chatActionIdMatches(result.body.chatThreadId, threadId) &&
      Date.parse(result.body.expiresAt) > now()
      ? result.body
      : null;
  });
  const selectedHost$ = computed(async (get) => {
    const chosen = get(chosenHostId$);
    const request = await get(request$);
    const hosts =
      request?.hosts.filter((host) => {
        return host.status === "online";
      }) ?? [];
    const preferred = chosen ?? request?.computerUseHostId;
    return (
      hosts.find((host) => {
        return host.id === preferred;
      }) ?? (chosen === null && hosts.length === 1 ? hosts[0] : null)
    );
  });
  const selectHost$ = command(({ set }, id: string | null) => {
    set(chosenHostId$, id);
  });
  const refresh$ = command(({ set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
  });
  const authorize$ = command(async ({ get, set }, signal: AbortSignal) => {
    const request = await get(request$);
    signal.throwIfAborted();
    const host = await get(selectedHost$);
    signal.throwIfAborted();
    if (
      !request ||
      (!host && !request.completedAt) ||
      Date.parse(request.expiresAt) <= now()
    ) {
      throw new Error("Computer Use authorization is unavailable in this chat");
    }
    if (!request.completedAt && host) {
      await accept(
        get(apiClient$)(computerUseAuthorizationRequestsContract).apply({
          params: { requestToken: descriptor.requestToken },
          body: { computerUseHostId: host.id },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
    }
    set(refresh$);
    await set(
      runAuthorizationChatCallback$,
      {
        originalUrl: descriptor.originalUrl,
        chatThreadId: threadId,
        authorizationId: request.id,
      },
      signal,
    );
    set(refresh$);
  });
  const armExpiration$ = command(async ({ get, set }, signal: AbortSignal) => {
    const request = await get(request$);
    signal.throwIfAborted();
    if (request) {
      timeout(
        () => {
          set(expired$, true);
        },
        Math.max(0, Date.parse(request.expiresAt) - now()),
        { signal },
      );
    }
  });
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    detach(set(armExpiration$, signal), Reason.Daemon);
    for (const topic of [
      "computerUseHostsChanged",
      "desktopShellAuthorizationChanged",
    ]) {
      set(setAblyLoop$, { topic, loopCommand$: invalidate$ }, signal);
    }
  });
  return {
    ...descriptor,
    request$,
    selectedHost$,
    selectHost$,
    authorize$,
    subscribe$,
  };
}

export type ComputerUseAuthorizationSignals = ReturnType<
  typeof createComputerUseAuthorizationSignals
>;

export function createComputerUseAuthorizationCardSignalsRegistry(
  threadId: string,
) {
  return createCardSignalsRegistry(
    (descriptor: ComputerUseAuthorizationDescriptor) => {
      return descriptor.href;
    },
    (descriptor) => {
      return createComputerUseAuthorizationSignals(descriptor, threadId);
    },
    (signals) => {
      return signals.subscribe$;
    },
  );
}
