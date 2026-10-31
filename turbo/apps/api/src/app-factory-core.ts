import { command } from "ccstate";
import type { Hono } from "hono";

import { createAppWithRoutes as createRuntimeAppWithRoutes } from "./app-factory-runtime";
import type { RouteEntry } from "./signals/route-entry";
import { configureChatRunFinishedEventDispatcher$ } from "./signals/services/chat-run-finished-event-registration.service";

const initializeApiServices$ = command(({ set }): void => {
  set(configureChatRunFinishedEventDispatcher$);
});

interface CreateAppWithRoutesOptions {
  readonly signal: AbortSignal;
  readonly routes: readonly RouteEntry[];
}

export function createAppWithRoutes({
  routes,
  signal,
}: CreateAppWithRoutesOptions): Hono {
  return createRuntimeAppWithRoutes({
    routes,
    signal,
    initializeServices$: initializeApiServices$,
  });
}
