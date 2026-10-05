import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../../views/okou-page/sidebar-breakpoint.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

const mobileViewport$ = state(false);
const agentComposeRequested$ = state(false);

export const pwaNavigationEnabled$ = computed((get) => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.PwaNavigation] === true &&
    get(mobileViewport$)
  );
});

export const pwaChatListVisible$ = computed((get) => {
  return get(pwaNavigationEnabled$) && !get(agentComposeRequested$);
});

// Prompt and template links still open their prepared composer. A bare agent
// chat URL is the list; starting a new chat opens its existing thread route.
export const setPwaAgentComposeRequested$ = command(
  ({ set }, requested: boolean) => {
    set(agentComposeRequested$, requested);
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
