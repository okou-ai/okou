import type { ClerkProviderProps } from "@clerk/react";
import type { Clerk, ClerkStatus } from "@clerk/shared/types";
import { command, computed, state } from "ccstate";
import { registerClerkRouter } from "../lib/clerk-runtime.ts";
import { onRef } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";
import { detachedNavigateTo$ } from "./route.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

type ClerkRouter = NonNullable<ClerkProviderProps["routerPush"]>;
type ClerkRouterMetadata = Parameters<ClerkRouter>[1];

function isAuthV1Pathname(pathname: string): boolean {
  return (
    pathname === ROUTES.signIn ||
    pathname.startsWith(`${ROUTES.signIn}/`) ||
    pathname === ROUTES.signUp ||
    pathname.startsWith(`${ROUTES.signUp}/`)
  );
}

/**
 * Keeps Clerk's hosted auth steps in app history and reloads on auth exit.
 *
 * Authenticated startup is document-scoped: feature switches, the realtime
 * daemon, the shared database bridge and the onboarding guard all run once from
 * `bootstrap$` and return early while signed out. Leaving the hosted sign-in or
 * sign-up routes therefore needs a new document, while their internal factor
 * and task steps remain same-document navigations without a loading flash.
 */
export function createAuthV1ClerkSignals(clerk: Pick<Clerk, "on" | "off">) {
  const navigateClerkUrl$ = command(
    ({ set }, url: string, replace: boolean): void => {
      const destination = new URL(url, window.location.href);
      if (
        destination.origin === window.location.origin &&
        isAuthV1Pathname(destination.pathname)
      ) {
        set(detachedNavigateTo$, destination.pathname as RoutePath, {
          hash: destination.hash,
          replace,
          searchParams: destination.searchParams,
        });
        return;
      }
      if (replace) {
        window.location.replace(destination.href);
        return;
      }
      window.location.assign(destination.href);
    },
  );
  const clerkRouterPush$ = command(
    ({ set }, url: string, _metadata?: ClerkRouterMetadata): void => {
      set(navigateClerkUrl$, url, false);
    },
  );
  const clerkRouterReplace$ = command(
    ({ set }, url: string, _metadata?: ClerkRouterMetadata): void => {
      set(navigateClerkUrl$, url, true);
    },
  );
  const status$ = state<ClerkStatus>("loading");
  const ready$ = computed((get) => {
    const status = get(status$);
    return status === "ready" || status === "degraded";
  });
  const receiveStatus$ = command(({ set }, status: ClerkStatus) => {
    set(status$, status);
  });
  const observe$ = command(
    ({ set }, clerk: Pick<Clerk, "on" | "off">, signal: AbortSignal): void => {
      if (signal.aborted) {
        return;
      }
      const receiveStatus = (status: ClerkStatus) => {
        if (!signal.aborted) {
          set(receiveStatus$, status);
        }
      };
      // Request the current value too: the provider may mount after bootstrap.
      clerk.on("status", receiveStatus, { notify: true });
      signal.addEventListener(
        "abort",
        () => {
          clerk.off("status", receiveStatus);
        },
        { once: true },
      );
    },
  );
  // The provider handle arrives at its committed marker. Own the subscription
  // through onRef so replacement and unmount release the exact SDK listener.
  const attach$ = onRef(
    command(({ get, set }, _element: HTMLSpanElement, signal: AbortSignal) => {
      const routeSignal = AbortSignal.any([signal, get(pageSignal$)]);
      if (routeSignal.aborted) {
        return;
      }
      const unregisterRouter = registerClerkRouter({
        push(url, metadata) {
          set(clerkRouterPush$, url, metadata);
        },
        replace(url, metadata) {
          set(clerkRouterReplace$, url, metadata);
        },
      });
      routeSignal.addEventListener("abort", unregisterRouter, {
        once: true,
      });
      set(observe$, clerk, routeSignal);
    }),
  );
  return { ready$, attach$, clerkRouterPush$, clerkRouterReplace$ };
}

export type AuthV1ClerkSignals = ReturnType<typeof createAuthV1ClerkSignals>;
