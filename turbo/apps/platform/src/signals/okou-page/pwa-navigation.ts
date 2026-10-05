import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../../views/okou-page/sidebar-breakpoint.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

const mobileStandalone$ = state(false);
const agentComposeRequested$ = state(false);

export const pwaNavigationEnabled$ = computed((get) => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.PwaNavigation] === true &&
    get(mobileStandalone$)
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
  const standalone = window.matchMedia("(display-mode: standalone)");
  const update = () => {
    const iosStandalone =
      "standalone" in navigator && navigator.standalone === true;
    set(
      mobileStandalone$,
      !desktop.matches && (standalone.matches || iosStandalone),
    );
  };
  update();
  desktop.addEventListener("change", update, { signal });
  standalone.addEventListener("change", update, { signal });
});
