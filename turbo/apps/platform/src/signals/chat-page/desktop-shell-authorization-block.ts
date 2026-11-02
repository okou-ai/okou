import { command, computed, state } from "ccstate";
import { uuid } from "zod";
import { timeout } from "signal-timers";
import { desktopShellAuthorizationContract } from "@okouai/api-contracts/client/desktop-shell-authorization";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
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
  const parsed = uuid().safeParse(match?.[1]);
  return parsed.success ? { id: parsed.data, originalUrl: value } : null;
}

export function createDesktopShellAuthorizationSignals(
  descriptor: DesktopShellAuthorizationDescriptor,
  threadId?: string,
) {
  const revision$ = state(0);
  const response$ = computed(async (get) => {
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
  const elapsedDeadline$ = state<string | null>(null);
  const request$ = computed(async (get) => {
    const elapsedDeadline = get(elapsedDeadline$);
    const response = await get(response$);
    const deadline =
      response?.status === "pending"
        ? response.requestExpiresAt
        : response?.status === "approved"
          ? response.grantExpiresAt
          : null;
    return response &&
      deadline &&
      (deadline === elapsedDeadline || Date.parse(deadline) <= now())
      ? { ...response, status: "expired" as const }
      : response;
  });
  const deadlineOwner$ = state<{ readonly rearm: () => void } | null>(null);
  const resetDeadline$ = resetSignal();
  const armDeadline$ = command(async ({ get, set }, owner: AbortSignal) => {
    const signal = set(resetDeadline$, owner);
    signal.throwIfAborted();
    const response = await get(response$);
    signal.throwIfAborted();
    const deadline =
      response?.status === "pending"
        ? response.requestExpiresAt
        : response?.status === "approved"
          ? response.grantExpiresAt
          : null;
    if (!deadline) {
      return;
    }
    const remaining = Date.parse(deadline) - now();
    if (remaining <= 0) {
      set(elapsedDeadline$, deadline);
      return;
    }
    // Expiry changes only the effective local status, not the HTTP response.
    // A refresh/action replaces this one-shot deadline under the same owner.
    // Record elapsed time so an early wall-clock sample cannot lose the wakeup.
    timeout(
      () => {
        set(elapsedDeadline$, deadline);
      },
      remaining,
      { signal },
    );
  });
  const refresh$ = command(({ get, set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
    get(deadlineOwner$)?.rearm();
  });
  const act$ = command(
    async (
      { get },
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
      return result.body;
    },
  );
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const rearm = () => {
      if (!signal.aborted) {
        detach(set(armDeadline$, signal), Reason.Daemon);
      }
    };
    set(deadlineOwner$, { rearm });
    rearm();
    for (const topic of [
      "desktopShellAuthorizationChanged",
      "computerUseHostsChanged",
    ]) {
      set(setAblyLoop$, { topic, loopCommand$: invalidate$ }, signal);
    }
  });
  return { ...descriptor, request$, act$, subscribe$ };
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
    (signals) => {
      return signals.subscribe$;
    },
  );
}
