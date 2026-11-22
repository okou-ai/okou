import { command, computed, state } from "ccstate";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../../views/okou-page/sidebar-breakpoint.ts";

const mobileViewport$ = state(false);
const composeRequested$ = state(false);

export const mobileChatViewport$ = computed((get) => {
  return get(mobileViewport$);
});

export const pwaChatListVisible$ = computed((get) => {
  return get(mobileViewport$) && !get(composeRequested$);
});

// Prompt and template links still open their prepared composer. The chat home
// URL is the list; starting a new chat opens its existing thread route.
export function isPwaComposeRequested(searchParams: URLSearchParams): boolean {
  return Boolean(
    searchParams.get("prompt") ||
    searchParams.get("handoff") ||
    searchParams.get("templatePicker") ||
    searchParams.get("compose") === "1",
  );
}

export const setPwaComposeRequested$ = command(
  ({ set }, requested: boolean) => {
    set(composeRequested$, requested);
  },
);

export const setupPwaNavigation$ = command(({ set }, signal: AbortSignal) => {
  const desktop = window.matchMedia(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const update = () => {
    set(mobileViewport$, !desktop.matches);
  };
  update();
  desktop.addEventListener("change", update, { signal });
});
