import type { RequestBodyPolicy } from "./context/hono";
import type { ClientResponseTransform } from "@okouai/api-contracts/client-transforms/types";
import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import type { JsonResponseObserver, SignalRouteHandler } from "./context/route";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
  readonly requestBodyPolicy?: RequestBodyPolicy;
  readonly responseTransforms?: readonly ClientResponseTransform[];
  readonly observeJsonResponse?: JsonResponseObserver;
  readonly streamJsonResponse?: boolean;
}

function routeRegistrationKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

export function assertUniqueRouteRegistrations(
  routes: readonly RouteEntry[],
): void {
  const keys = new Set<string>();
  for (const entry of routes) {
    const key = routeRegistrationKey(entry);
    if (keys.has(key)) {
      throw new Error(`Duplicate API route registration: ${key}`);
    }
    keys.add(key);
  }
}
