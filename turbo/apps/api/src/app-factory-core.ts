import type { Hono } from "hono";

import {
  createAppWithRoutes as createDomainApp,
  type CreateAppWithRoutesOptions,
} from "./app-factory-base";
import { configureChatRunFinishedEventDispatcher$ } from "./signals/services/chat-run-finished-event-registration.service";

/** Existing Node, nested MCP, and test compositions retain full initialization. */
export function createAppWithRoutes(
  options: Omit<CreateAppWithRoutesOptions, "initializeServices$">,
): Hono {
  return createDomainApp({
    ...options,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
}
