import { command, computed, state } from "ccstate";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
export type NetworkGuideProvider = "tailscale" | "cloudflare";
export const REMOTE_NETWORK_GUIDE_STEP_COUNT = 3;
interface NetworkGuide {
  readonly sessionKey: string | null;
  readonly provider: NetworkGuideProvider;
  readonly step: number;
  readonly tags: string;
  readonly open: boolean;
}
const guide$ = state<NetworkGuide | null>(null);
export const remoteNetworkGuide$ = computed((get) => {
  const current = get(guide$);
  return get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] &&
    current?.sessionKey === get(authenticatedSessionKey$)
    ? current
    : null;
});
export const openRemoteNetworkGuide$ = command(
  (
    { get, set },
    provider: NetworkGuideProvider,
    tags: string,
    restart = false,
  ) => {
    const previous = get(remoteNetworkGuide$);
    set(guide$, {
      sessionKey: get(authenticatedSessionKey$),
      provider,
      tags,
      open: true,
      step: !restart && previous?.provider === provider ? previous.step : 0,
    });
  },
);
export const moveRemoteNetworkGuide$ = command(
  ({ get, set }, delta: number) => {
    const current = get(remoteNetworkGuide$);
    if (current) {
      set(guide$, {
        ...current,
        step: Math.max(
          0,
          Math.min(REMOTE_NETWORK_GUIDE_STEP_COUNT - 1, current.step + delta),
        ),
      });
    }
  },
);
export const closeRemoteNetworkGuide$ = command(
  ({ get, set }, finished = false) => {
    const current = get(remoteNetworkGuide$);
    if (current) {
      set(guide$, {
        ...current,
        open: false,
        step: finished ? 0 : current.step,
      });
    }
  },
);
