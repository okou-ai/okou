import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { searchParams$, updateSearchParams$ } from "./route.ts";

type NetworkEditorProvider = "tailscale" | "cloudflare";

export function clearRemoteNetworkParams(params: URLSearchParams) {
  for (const name of [
    "network",
    "networkEdit",
    "networkGuide",
    "networkStep",
    "networkTags",
    "networkGuideClosed",
  ]) {
    params.delete(name);
  }
}

export const remoteNetworkLocation$ = computed((get) => {
  const params = get(searchParams$);
  if (
    !get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] ||
    params.get("scope") !== "private-network"
  ) {
    return null;
  }
  const provider = params.get("network");
  if (
    provider !== "add" &&
    provider !== "tailscale" &&
    provider !== "cloudflare"
  ) {
    return null;
  }
  return { provider, id: params.get("networkEdit") || null };
});

export const openRemoteNetworkEditor$ = command(
  (
    { get, set },
    provider: "add" | NetworkEditorProvider,
    id: string | null = null,
  ) => {
    const params = new URLSearchParams(get(searchParams$));
    if (
      !get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] ||
      params.get("scope") !== "private-network"
    ) {
      return;
    }
    if (
      params.get("network") === provider &&
      (params.get("networkEdit") || null) === id
    ) {
      return;
    }
    clearRemoteNetworkParams(params);
    params.set("network", provider);
    if (id) {
      params.set("networkEdit", id);
    }
    set(updateSearchParams$, params);
  },
);

export const closeRemoteNetworkEditor$ = command(
  ({ get, set }, provider?: NetworkEditorProvider) => {
    const current = get(remoteNetworkLocation$);
    if (!current || (provider && current.provider !== provider)) {
      return;
    }
    const params = new URLSearchParams(get(searchParams$));
    clearRemoteNetworkParams(params);
    set(updateSearchParams$, params);
  },
);
