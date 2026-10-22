import { command, computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
export type NetworkGuideProvider = "tailscale" | "cloudflare";
const REMOTE_NETWORK_GUIDE_STEP_COUNT = Object.freeze({
  tailscale: 4,
  cloudflare: 3,
});
interface NetworkGuide {
  readonly provider: NetworkGuideProvider;
  readonly step: number;
  readonly tags: string;
  readonly open: boolean;
}
export const remoteNetworkGuide$ = computed<NetworkGuide | null>((get) => {
  const params = get(searchParams$);
  const provider = params.get("networkGuide");
  if (
    !get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] ||
    (provider !== "tailscale" && provider !== "cloudflare")
  ) {
    return null;
  }
  const step = Number(params.get("networkStep"));
  return {
    provider,
    step:
      Number.isInteger(step) &&
      step >= 1 &&
      step <= REMOTE_NETWORK_GUIDE_STEP_COUNT[provider]
        ? step - 1
        : 0,
    tags: params.get("networkTags") ?? "",
    open: params.get("networkGuideClosed") !== "1",
  };
});
export const openRemoteNetworkGuide$ = command(
  (
    { get, set },
    provider: NetworkGuideProvider,
    tags: string,
    restart = false,
  ) => {
    const previous = get(remoteNetworkGuide$);
    const params = new URLSearchParams(get(searchParams$));
    params.set("networkGuide", provider);
    params.delete("networkGuideClosed");
    params.set(
      "networkStep",
      String(
        !restart && previous?.provider === provider ? previous.step + 1 : 1,
      ),
    );
    if (tags) {
      params.set("networkTags", tags);
    } else {
      params.delete("networkTags");
    }
    set(updateSearchParams$, params);
  },
);
export const moveRemoteNetworkGuide$ = command(
  ({ get, set }, delta: number) => {
    const current = get(remoteNetworkGuide$);
    if (current) {
      const params = new URLSearchParams(get(searchParams$));
      params.set(
        "networkStep",
        String(
          Math.max(
            1,
            Math.min(
              REMOTE_NETWORK_GUIDE_STEP_COUNT[current.provider],
              current.step + 1 + delta,
            ),
          ),
        ),
      );
      set(updateSearchParams$, params);
    }
  },
);
export const closeRemoteNetworkGuide$ = command(
  ({ get, set }, finished = false) => {
    const current = get(remoteNetworkGuide$);
    if (current) {
      const params = new URLSearchParams(get(searchParams$));
      params.set("networkGuideClosed", "1");
      if (finished) {
        params.set("networkStep", "1");
      }
      set(updateSearchParams$, params);
    }
  },
);
