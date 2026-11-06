import { computed } from "ccstate";
import { match } from "path-to-regexp";
import { pathname$ } from "./route.ts";
import { ROUTES, type RouteKey } from "./route-paths.ts";
import { singleAgentEnabled$ } from "./single-agent.ts";

export const activeRoute$ = computed((get): RouteKey | null => {
  const path = get(pathname$);
  for (const [key, pattern] of Object.entries(ROUTES)) {
    if (match(pattern, { decode: decodeURIComponent })(path)) {
      return key as RouteKey;
    }
  }
  return null;
});

/** The agent chat page: `/agents/:agentId/chat`, or `/` under My Okou. */
export const agentChatPageActive$ = computed((get): boolean => {
  const route = get(activeRoute$);
  return (
    route === "agentChat" || (route === "home" && get(singleAgentEnabled$))
  );
});
