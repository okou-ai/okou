import { command, computed, state } from "ccstate";
import { uuid } from "zod";
import { timeout } from "signal-timers";
import { vncAuthorizationContract } from "@okouai/api-contracts/client/vnc-authorization";
import { sshAuthorizationContract } from "@okouai/api-contracts/client/ssh-authorization";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface HostAuthorizationDescriptor {
  readonly id: string;
  readonly originalUrl: string;
}
export function parseHostAuthorizationUrl(
  protocol: "ssh" | "vnc",
  value: string,
): HostAuthorizationDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  const match = url?.pathname.match(
    new RegExp(`^/${protocol}/authorize/([^/]+)$`, "u"),
  );
  const id = uuid().safeParse(match?.[1]);
  return id.success &&
    url?.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
    ? { id: id.data, originalUrl: value }
    : null;
}
export function createHostAuthorizationSignals(
  protocol: "ssh" | "vnc",
  descriptor: HostAuthorizationDescriptor,
  threadId?: string,
) {
  const revision$ = state(0);
  const request$ = computed(async (get) => {
    get(revision$);
    const result =
      protocol === "ssh"
        ? await accept(
            get(apiClient$)(sshAuthorizationContract).get({
              params: { id: descriptor.id },
            }),
            [200, 403, 404],
          )
        : await accept(
            get(apiClient$)(vncAuthorizationContract).get({
              params: { id: descriptor.id },
            }),
            [200, 403, 404],
          );
    return result.status === 200 &&
      (threadId === undefined || result.body.chatThreadId === threadId)
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
        throw new Error(
          `${protocol.toUpperCase()} authorization is unavailable in this chat`,
        );
      }
      if (protocol === "ssh") {
        await accept(
          get(apiClient$)(sshAuthorizationContract)[action]({
            params: { id: descriptor.id },
            body: {},
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
      } else {
        await accept(
          get(apiClient$)(vncAuthorizationContract)[action]({
            params: { id: descriptor.id },
            body: {},
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
      }
      set(refresh$);
    },
  );
  const resetDeadline$ = resetSignal();
  const armDeadline$ = command(async ({ get, set }, parent: AbortSignal) => {
    const signal = set(resetDeadline$, parent);
    const request = await get(request$);
    signal.throwIfAborted();
    if (request?.status === "pending") {
      const remaining = Date.parse(request.requestExpiresAt) - now();
      if (remaining > 0) {
        timeout(
          () => {
            set(refresh$);
          },
          remaining,
          { signal },
        );
      }
    }
  });
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    detach(set(armDeadline$, signal), Reason.Daemon);
    // Browser and Shell already share the committed Run-eligibility hint.
    for (const topic of [
      "desktopShellAuthorizationChanged",
      "sshAuthorizationChanged",
      "vncAuthorizationChanged",
      "ssh:changed",
      "connectorPermissionUpdated",
      "connector:changed",
    ]) {
      set(setAblyLoop$, { topic, loopCommand$: invalidate$ }, signal);
    }
  });
  return { ...descriptor, protocol, request$, act$, refresh$, subscribe$ };
}
export type HostAuthorizationSignals = ReturnType<
  typeof createHostAuthorizationSignals
>;
export function createHostAuthorizationCardSignalsRegistry(
  protocol: "ssh" | "vnc",
  threadId: string,
) {
  return createCardSignalsRegistry(
    (descriptor: HostAuthorizationDescriptor) => {
      return descriptor.id;
    },
    (descriptor) => {
      return createHostAuthorizationSignals(protocol, descriptor, threadId);
    },
    (signals) => {
      return signals.subscribe$;
    },
  );
}
