import { closeSshDialog$ } from "./ssh.ts";
import { closeVncDialog$, vncEnabled$ } from "./vnc.ts";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { command, computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import {
  remoteControlGuidedEnabled$,
  remoteNetworkPicker$,
  selectedRemoteNetworkProvider$,
  setRemoteNetworkPicker$,
} from "./remote-control-setup.ts";
import {
  closeTailscaleDialog$,
  saveTailscale$,
  tailscaleDialog$,
  tailscaleConfigs$,
  tailscaleSettingsEnabled$,
  openTailscaleDialog$,
  replaceTailscaleCredentials$,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  saveCloudflareAccess$,
  cloudflareAccessDialog$,
  cloudflareAccessConfigs$,
  cloudflareAccessSummary$,
  openCloudflareAccessDialog$,
  replaceCloudflareAccessToken$,
} from "./cloudflare-access.ts";

export const editRemoteTailscaleCredentials$ = command(
  async ({ get, set }, config: TailscaleConfig, signal: AbortSignal) => {
    await set(openTailscaleDialog$, "edit", config, signal);
    signal.throwIfAborted();
    const dialog = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (dialog?.kind === "edit" && dialog.config?.id === config.id) {
      set(replaceTailscaleCredentials$, true);
    }
  },
);
export const editRemoteCloudflareCredentials$ = command(
  async (
    { get, set },
    config: ScopedCloudflareAccessConfig,
    signal: AbortSignal,
  ) => {
    await set(openCloudflareAccessDialog$, "edit", config, signal);
    signal.throwIfAborted();
    const dialog = await get(cloudflareAccessDialog$);
    signal.throwIfAborted();
    if (dialog?.kind === "edit" && dialog.config?.id === config.id) {
      set(replaceCloudflareAccessToken$, true);
    }
  },
);

export const privateNetworkDirectorySummary$ = computed(async (get) => {
  if (!get(remoteControlGuidedEnabled$)) {
    return await get(cloudflareAccessSummary$);
  }
  const [tailscale, cloudflare] = await Promise.all([
    get(tailscaleConfigs$),
    get(cloudflareAccessConfigs$),
  ]);
  return {
    configuredCount: (tailscale?.length ?? 0) + (cloudflare?.length ?? 0),
  };
});

export type RemoteResourceKind = "ssh" | "vnc" | "tailscale" | "cloudflare";
export function remoteResourceSearchParams(
  params: URLSearchParams,
  kind: RemoteResourceKind,
  id: string,
) {
  const next = new URLSearchParams(params);
  next.delete("setup");
  next.delete("networkConnections");
  next.set(
    "scope",
    kind === "ssh" || kind === "vnc" ? "remote-control" : "private-network",
  );
  next.set("remoteResource", `${kind}:${id}`);
  return next;
}
export const remoteNetworkConnections$ = computed((get) => {
  const params = get(searchParams$);
  if (
    !get(remoteControlGuidedEnabled$) ||
    params.get("scope") !== "private-network"
  ) {
    return null;
  }
  const [kind, id] = (params.get("networkConnections") ?? "").split(":");
  return id &&
    (kind === "cloudflare" ||
      (kind === "tailscale" && get(tailscaleSettingsEnabled$)))
    ? { kind, id }
    : null;
});
export const closeRemoteNetworkConnections$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete("networkConnections");
  set(updateSearchParams$, params);
});
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
  if (kind === "vnc" && !get(vncEnabled$)) {
    return null;
  }
  if (kind === "tailscale" && !get(tailscaleSettingsEnabled$)) {
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

export const saveRemoteTailscale$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    await set(saveTailscale$, form, signal);
    signal.throwIfAborted();
    const remaining = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (!remaining) {
      set(closeRemoteNetworkPage$);
    }
  },
);
export const saveRemoteCloudflare$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const savedId = await set(saveCloudflareAccess$, form, signal);
    signal.throwIfAborted();
    const remaining = await get(cloudflareAccessDialog$);
    signal.throwIfAborted();
    if (!remaining) {
      set(closeRemoteNetworkPage$);
    }
    return savedId;
  },
);
