import { command } from "ccstate";
import { z } from "zod";
import {
  desktopAuthCallbackSchemeSchema,
  desktopAuthHandoffContract,
  type DesktopAuthCallbackScheme,
} from "@okouai/api-contracts/contracts/desktop-auth";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { clerk$, resolveAppAuthUrl } from "../auth.ts";
import { readClerkToken } from "../clerk-token.ts";
import {
  createDeferredPromise,
  waitForOperation,
  withCleanup,
} from "../utils.ts";

declare global {
  interface Window {
    vm0DesktopAuth?: {
      completeSignIn?: (input: { token: string }) => Promise<void>;
    };
  }
}

export type DesktopAuthRoute =
  | "start"
  | "callback"
  | "consume"
  | "token"
  | "select-org";

export function desktopAuthUrl(
  route: DesktopAuthRoute,
  params = new URLSearchParams(),
): string {
  const url = new URL(`/desktop-auth/${route}`, location.origin);
  url.search = params.toString();
  return url.toString();
}

export function callbackScheme(
  params: URLSearchParams,
): DesktopAuthCallbackScheme {
  const scheme = desktopAuthCallbackSchemeSchema.safeParse(
    params.get("callbackScheme"),
  );
  if (!scheme.success) {
    throw new Error("Invalid desktop callback scheme");
  }
  return scheme.data;
}

export function handoffParams(params: URLSearchParams): URLSearchParams {
  const handoffId = params.get("handoffId");
  if (handoffId !== null && !z.uuid().safeParse(handoffId).success) {
    throw new Error("Invalid desktop handoff");
  }
  return new URLSearchParams(handoffId ? { handoffId } : {});
}

export function validateDesktopCallback(
  url: string,
  scheme: DesktopAuthCallbackScheme,
  handoffId: string,
): void {
  const callback = new URL(url);
  if (
    callback.protocol !== `${scheme}:` ||
    callback.host !== "auth" ||
    callback.pathname !== "/callback" ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.searchParams.get("handoffId") !== handoffId ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(callback.searchParams.get("code") ?? "") ||
    callback.searchParams.size !== 2
  ) {
    throw new Error("Invalid desktop callback");
  }
}

/** Clerk/IPC cannot abort their promises; stop waiting and discard late results. */
export function waitForDesktopOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return waitForOperation(operation, signal);
}

export const waitForDesktopIdentity$ = command(
  async (
    { get },
    sessionId: string,
    organizationId: string | undefined,
    signal: AbortSignal,
  ) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const matches = () => {
      return (
        clerk.session?.id === sessionId &&
        (organizationId === undefined ||
          (clerk.organization?.id === organizationId &&
            clerk.session.lastActiveOrganizationId === organizationId))
      );
    };
    if (matches()) {
      return;
    }
    const ready = createDeferredPromise<void>(signal);
    const check = () => {
      if (matches() && !ready.settled()) {
        ready.resolve();
      }
    };
    const unsubscribe = clerk.addListener(check, { skipInitialEmit: true });
    check();
    await withCleanup(ready.promise, unsubscribe);
  },
);

export const continueDesktopTask$ = command(
  async (
    { get },
    destination: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const task = clerk.session?.currentTask;
    if (!task) {
      return false;
    }
    location.replace(
      resolveAppAuthUrl(`/sign-in/tasks/${task.key}`, {
        redirectUrl: destination,
      }),
    );
    return true;
  },
);

export const completeDesktopSession$ = command(
  async ({ get }, params: URLSearchParams, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const sessionId = clerk.session?.id;
    const orgId = clerk.organization?.id;
    if (
      !sessionId ||
      !orgId ||
      clerk.session?.currentTask ||
      clerk.session?.lastActiveOrganizationId !== orgId
    ) {
      throw new Error("Missing desktop identity");
    }
    const token = await readClerkToken(clerk, signal, { skipCache: true });
    signal.throwIfAborted();
    const assertIdentity = () => {
      signal.throwIfAborted();
      if (
        clerk.session?.id !== sessionId ||
        clerk.organization?.id !== orgId ||
        clerk.session.lastActiveOrganizationId !== orgId ||
        clerk.session?.currentTask
      ) {
        throw new Error("Desktop identity changed");
      }
    };
    assertIdentity();
    const completeSignIn = window.vm0DesktopAuth?.completeSignIn;
    if (!token || !completeSignIn) {
      throw new Error("Desktop token delivery unavailable");
    }
    await waitForDesktopOperation(completeSignIn({ token }), signal);
    assertIdentity();
    const handoffId = params.get("handoffId");
    if (handoffId) {
      // The normal client replaces Authorization. Pin its provider to the same
      // fresh identity already delivered through IPC, including on later reads.
      const client = get(apiClient$)(desktopAuthHandoffContract, {
        getToken: () => {
          assertIdentity();
          return Promise.resolve(token);
        },
      });
      const response = await accept(
        client.complete({
          params: { handoffId },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      );
      if (response.body.status !== "completed") {
        throw new Error("Desktop completion was not acknowledged");
      }
    }
    assertIdentity();
    // Electron and Swift observe document navigation, not SPA history updates.
    location.replace("/");
  },
);
