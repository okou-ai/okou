import { match } from "path-to-regexp";
import { ROUTES } from "../route-paths.ts";
import { isPwaAgentComposeRequested } from "./pwa-navigation.ts";

export type PwaPageTransitionDirection = "push" | "pop" | "none";

interface PwaPageLocation {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

// The chats tab is `/`, which is My Okou's chat page, or an agent chat URL.
const matchChatPages = [ROUTES.home, ROUTES.agentChat].map((path) => {
  return match(path);
});
const matchTabRoots = [ROUTES.connectors, ROUTES.artifacts, ROUTES.me].map(
  (path) => {
    return match(path);
  },
);

// Only the four bottom tab destinations are root pages. A chat page URL that
// opens its composer is a nested page, like every other route.
function isTabRootPage({ pathname, searchParams }: PwaPageLocation): boolean {
  if (
    matchChatPages.some((matchChatPage) => {
      return Boolean(matchChatPage(pathname));
    })
  ) {
    return !isPwaAgentComposeRequested(searchParams);
  }
  return matchTabRoots.some((matchTabRoot) => {
    return Boolean(matchTabRoot(pathname));
  });
}

// Entering a nested page from a tab root slides it in; returning to a tab root
// from a nested page slides it out. Every other navigation has no animation.
export function pwaPageTransitionDirection(
  from: PwaPageLocation,
  to: PwaPageLocation,
): PwaPageTransitionDirection {
  const fromRoot = isTabRootPage(from);
  const toRoot = isTabRootPage(to);
  if (fromRoot && !toRoot) {
    return "push";
  }
  if (!fromRoot && toRoot) {
    return "pop";
  }
  return "none";
}
