import { closeSshDialog$ } from "./ssh.ts";
import { closeVncDialog$ } from "./vnc.ts";
import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import {
  remoteControlGuidedEnabled$,
  remoteNetworkPicker$,
  selectedRemoteNetworkProvider$,
  setRemoteNetworkPicker$,
} from "./remote-control-setup.ts";
import { closeTailscaleDialog$, tailscaleDialog$ } from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  cloudflareAccessDialog$,
} from "./cloudflare-access.ts";

export type RemoteResourceKind = "ssh" | "vnc" | "tailscale" | "cloudflare";
export function remoteResourceHref(
  params: URLSearchParams,
  kind: RemoteResourceKind,
  id: string,
) {
  const next = new URLSearchParams(params);
  next.delete("setup");
  next.set(
    "scope",
    kind === "ssh" || kind === "vnc" ? "remote-control" : "private-network",
  );
  next.set("remoteResource", `${kind}:${id}`);
  return `/connectors?${next.toString()}`;
}
export const remoteResource$ = computed((get) => {
  if (!get(remoteControlGuidedEnabled$)) {
    return null;
  }
  const params = get(searchParams$);
  const [kind, id] = (params.get("remoteResource") ?? "").split(":");
  if (
    !id ||
    (kind !== "ssh" &&
      kind !== "vnc" &&
      kind !== "tailscale" &&
      kind !== "cloudflare")
  ) {
    return null;
  }
  const network = kind === "tailscale" || kind === "cloudflare";
  if (
    params.get("scope") !== (network ? "private-network" : "remote-control")
  ) {
    return null;
  }
  if (kind === "vnc" && !get(featureSwitch$)[FeatureSwitchKey.VncAccess]) {
    return null;
  }
  if (
    kind === "tailscale" &&
    !get(featureSwitch$)[FeatureSwitchKey.TailscaleAccess]
  ) {
    return null;
  }
  return { kind, id };
});
export const closeRemoteResource$ = command(({ get, set }) => {
  set(closeSshDialog$);
  set(closeVncDialog$);
  set(closeTailscaleDialog$);
  set(closeCloudflareAccessDialog$);
  const params = new URLSearchParams(get(searchParams$));
  params.delete("remoteResource");
  set(updateSearchParams$, params);
});
export const remoteNetworkPage$ = computed(async (get) => {
  if (
    !get(remoteControlGuidedEnabled$) ||
    get(searchParams$).get("scope") !== "private-network"
  ) {
    return null;
  }
  if (get(remoteNetworkPicker$)) {
    return "provider";
  }
  const [tailscale, cloudflare] = await Promise.all([
    get(tailscaleDialog$),
    get(cloudflareAccessDialog$),
  ]);
  const provider = get(selectedRemoteNetworkProvider$);
  if (
    tailscale?.kind === "edit" ||
    (provider === "tailscale" && tailscale?.kind === "create")
  ) {
    return "tailscale";
  }
  if (
    cloudflare?.kind === "edit" ||
    (provider === "cloudflare_access" && cloudflare?.kind === "create")
  ) {
    return "cloudflare";
  }
  return null;
});
export const closeRemoteNetworkPage$ = command(({ set }) => {
  set(setRemoteNetworkPicker$, false);
  set(closeTailscaleDialog$);
  set(closeCloudflareAccessDialog$);
});
