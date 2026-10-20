import { command, computed, state } from "ccstate";
import { z } from "zod";
import { desktopShellAuthorizationContract } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRef, setLoop } from "../utils.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface DesktopShellAuthorizationDescriptor {
  readonly id: string;
  readonly originalUrl: string;
}

export function parseDesktopShellAuthorizationUrl(
  value: string,
): DesktopShellAuthorizationDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  const match = url?.pathname.match(
    /^\/computer-use\/shell\/authorize\/([^/]+)$/u,
  );
  const parsed = z.uuid().safeParse(match?.[1]);
  return parsed.success ? { id: parsed.data, originalUrl: value } : null;
}

export function createDesktopShellAuthorizationSignals(
  descriptor: DesktopShellAuthorizationDescriptor,
  threadId?: string,
) {
  const revision$ = state(0);
  const request$ = computed(async (get) => {
    get(revision$);
    const client = get(apiClient$)(desktopShellAuthorizationContract);
    const result = await accept(
      client.get({ params: { id: descriptor.id } }),
      [200, 403, 404],
    );
    if (result.status !== 200) {
      return null;
    }
    return threadId === undefined || result.body.chatThreadId === threadId
      ? result.body
      : null;
  });
  const refresh$ = command(({ set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
  });
  const act$ = command(
    async (
      { get, set },
      action: "approve" | "deny" | "revoke",
      signal: AbortSignal,
    ) => {
      const request = await get(request$);
      signal.throwIfAborted();
      if (!request) {
        throw new Error("Shell authorization is unavailable in this chat");
      }
      const client = get(apiClient$)(desktopShellAuthorizationContract);
      const result = await accept(
        client[action]({
          params: { id: descriptor.id },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(refresh$);
      return result.body;
    },
  );
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const poll$ = command(async ({ get, set }, signal: AbortSignal) => {
    const request = await get(request$);
    signal.throwIfAborted();
    if (!request || !["pending", "approved"].includes(request.status)) {
      return true;
    }
    if (
      request.status === "pending" ||
      (request.grantExpiresAt !== null &&
        Date.parse(request.grantExpiresAt) <= now())
    ) {
      set(refresh$);
    }
    return false;
  });
  const ref$ = onRef(
    command(
      ({ set }, _element: HTMLElement | SVGSVGElement, signal: AbortSignal) => {
        set(
          setAblyLoop$,
          {
            topic: "desktopShellAuthorizationChanged",
            loopCommand$: invalidate$,
            options: { runOnSubscribe: true },
          },
          signal,
        );
        setLoop(
          () => {
            return set(poll$, signal);
          },
          3000,
          signal,
          {
            testIntervalMs: 3000,
          },
        );
      },
    ),
  );
  return { ...descriptor, request$, refresh$, act$, ref$ };
}

export type DesktopShellAuthorizationSignals = ReturnType<
  typeof createDesktopShellAuthorizationSignals
>;

export function createDesktopShellAuthorizationCardSignalsRegistry(
  threadId: string,
) {
  return createCardSignalsRegistry(
    (descriptor: DesktopShellAuthorizationDescriptor) => {
      return descriptor.id;
    },
    (descriptor) => {
      return createDesktopShellAuthorizationSignals(descriptor, threadId);
    },
  );
}
