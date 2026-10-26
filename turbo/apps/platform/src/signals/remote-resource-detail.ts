import { closeSshDialog$, openSshDialog$ } from "./ssh.ts";
import { closeVncDialog$, openVncDialog$, vncEnabled$ } from "./vnc.ts";
import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import { command, computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import {
  remoteControlGuidedEnabled$,
  setRemoteNetworkPicker$,
  startComputerSetup$,
  clearRemoteSetupParams,
} from "./remote-control-setup.ts";
import {
  remoteNetworkLocation$,
  clearRemoteNetworkParams,
} from "./remote-network-location.ts";
import {
  closeTailscaleDialog$,
  saveTailscale$,
  tailscaleDialog$,
  tailscaleConfigs$,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  saveCloudflareAccess$,
  cloudflareAccessDialog$,
  cloudflareAccessConfigs$,
  cloudflareAccessSummary$,
} from "./cloudflare-access.ts";

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
export type RemoteConnectionEditor =
  | { readonly kind: "ssh"; readonly connection: SshConnectionResponse }
  | { readonly kind: "vnc"; readonly connection: VncConnectionResponse };

export const openRemoteConnectionEditor$ = command(
  async ({ set }, resource: RemoteConnectionEditor, signal: AbortSignal) => {
    if (resource.kind === "ssh") {
      await set(openSshDialog$, "edit", resource.connection, signal);
    } else {
      await set(openVncDialog$, "edit", resource.connection, signal);
    }
    signal.throwIfAborted();
  },
);
export function remoteResourceSearchParams(
  params: URLSearchParams,
  kind: RemoteResourceKind,
  id: string,
) {
  const next = new URLSearchParams(params);
  next.delete("setup");
  clearRemoteSetupParams(next);
  clearRemoteNetworkParams(next);
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
  return id && (kind === "cloudflare" || kind === "tailscale")
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
export const remoteNetworkPage$ = computed((get) => {
  const location = get(remoteNetworkLocation$);
  return location?.provider === "add"
    ? "provider"
    : (location?.provider ?? null);
});
export const closeRemoteNetworkPage$ = command(({ get, set }) => {
  set(setRemoteNetworkPicker$, false);
  set(closeTailscaleDialog$);
  set(closeCloudflareAccessDialog$);
  if (get(searchParams$).get("setup") === "computer") {
    set(startComputerSetup$);
  }
});

export const saveRemoteTailscale$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const savedId = await set(saveTailscale$, form, signal);
    signal.throwIfAborted();
    const remaining = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (!remaining) {
      set(closeRemoteNetworkPage$);
    }
    return savedId;
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
