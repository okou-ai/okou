import { command, computed, state } from "ccstate";
import { remoteNetworkLocation$ } from "./remote-network-location.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import {
  closeTailscaleDialog$,
  openTailscaleDialog$,
  tailscaleConfigs$,
  tailscaleDialog$,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  openCloudflareAccessDialog$,
  cloudflareAccessConfigs$,
  cloudflareAccessDialog$,
} from "./cloudflare-access.ts";

const initialization$ = state<{
  readonly sessionKey: string | null;
  readonly provider: string;
  readonly id: string | null;
  readonly result: Promise<void>;
} | null>(null);
export const remoteNetworkInitialization$ = computed((get) => {
  const current = get(initialization$);
  const location = get(remoteNetworkLocation$);
  return current?.sessionKey === get(authenticatedSessionKey$) &&
    current?.provider === location?.provider &&
    current?.id === location?.id
    ? (current?.result ?? null)
    : null;
});

const restoreNetworkEditor$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const location = get(remoteNetworkLocation$);
    set(closeTailscaleDialog$, true);
    set(closeCloudflareAccessDialog$, true);
    if (!location || location.provider === "add") {
      return;
    }
    const kind = location.id ? "edit" : "create";
    if (location.provider === "tailscale") {
      const configs = location.id ? await get(tailscaleConfigs$) : null;
      signal.throwIfAborted();
      const config =
        configs?.find((item) => {
          return item.id === location.id;
        }) ?? null;
      if (location.id && !config) {
        throw new Error("Tailscale network is unavailable");
      }
      await set(openTailscaleDialog$, kind, config, signal);
      signal.throwIfAborted();
      if (!(await get(tailscaleDialog$))) {
        throw new Error("Tailscale editor is unavailable");
      }
    } else {
      const configs = location.id ? await get(cloudflareAccessConfigs$) : null;
      signal.throwIfAborted();
      const config =
        configs?.find((item) => {
          return item.id === location.id;
        }) ?? null;
      if (location.id && !config) {
        throw new Error("Cloudflare network is unavailable");
      }
      await set(openCloudflareAccessDialog$, kind, config, signal);
      signal.throwIfAborted();
      if (!(await get(cloudflareAccessDialog$))) {
        throw new Error("Cloudflare editor is unavailable");
      }
    }
    signal.throwIfAborted();
  },
);

export const setupRemoteNetworkEditor$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const location = get(remoteNetworkLocation$);
    const result = set(restoreNetworkEditor$, signal);
    set(
      initialization$,
      location
        ? {
            sessionKey: get(authenticatedSessionKey$),
            provider: location.provider,
            id: location.id,
            result,
          }
        : null,
    );
    // The page consumes both success and failure through useLoadable.
    return Promise.allSettled([result]);
  },
);
