import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import { resetSignal } from "./utils.ts";
import {
  chooseSshAuthMethod$,
  chooseSshConnectionMode$,
  chooseSshCredential$,
  chooseSshTailscaleConfig$,
  chooseSshAccessConfig$,
  closeSshDialog$,
  openSshDialog$,
  saveSsh$,
  sshDialog$,
} from "./ssh.ts";
import {
  closeVncDialog$,
  openVncDialog$,
  saveVnc$,
  vncDialog$,
  chooseVncProfile$,
  chooseVncTransport$,
  vncEditor$,
  requiresVncProtectiveRoute,
} from "./vnc.ts";
import {
  closeTailscaleDialog$,
  openTailscaleDialog$,
  saveTailscale$,
  tailscaleConfigs$,
  tailscaleDialog$,
  tailscaleEnabled$,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  openCloudflareAccessDialog$,
  saveCloudflareAccess$,
  cloudflareAccessConfigs$,
  cloudflareAccessDialog$,
} from "./cloudflare-access.ts";

export type RemoteSetupStep =
  | "entry"
  | "existing"
  | "install"
  | "address"
  | "tag"
  | "rule"
  | "oauth"
  | "prepare"
  | "os"
  | "service"
  | "cf-address"
  | "cf-access"
  | "login"
  | "saved";
export type RemoteSetupRoute = "direct" | "tailscale" | "cloudflare_access";
export type RemoteSetupOs = "mac" | "windows" | "linux";
export type RemoteVncStep = "profile" | "connection" | "login" | "trust";
export interface RemoteSetup {
  readonly sessionKey: string;
  readonly flowId: number;
  readonly protocol: "ssh" | "vnc";
  readonly step: RemoteSetupStep;
  readonly route: RemoteSetupRoute;
  readonly os: RemoteSetupOs;
  readonly address: string;
  readonly port: string;
  readonly networkId: string;
  readonly formStarted: boolean;
  readonly savedName: string;
  readonly vncStep: RemoteVncStep;
}

const setup$ = state<RemoteSetup | null>(null);
const flowSequence$ = state(0);
const resetSetupOperation$ = resetSignal();
export const remoteControlGuidedEnabled$ = computed((get) => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] ?? false
  );
});
function initialSetup(
  sessionKey: string,
  protocol: "ssh" | "vnc",
  flowId: number,
): RemoteSetup {
  return {
    sessionKey,
    flowId,
    protocol,
    step: "entry",
    route: "direct",
    os: "mac",
    address: "",
    port: protocol === "ssh" ? "22" : "5900",
    networkId: "",
    formStarted: false,
    savedName: "",
    vncStep: "profile",
  };
}
export const remoteSetup$ = computed((get) => {
  const sessionKey = get(authenticatedSessionKey$);
  if (
    !get(remoteControlGuidedEnabled$) ||
    !sessionKey ||
    get(searchParams$).get("scope") !== "remote-control"
  ) {
    return null;
  }
  const current = get(setup$);
  if (current?.sessionKey === sessionKey) {
    return current;
  }
  const deepLink = get(searchParams$).get("setup");
  if (
    deepLink === "ssh" ||
    (deepLink === "vnc" && get(featureSwitch$)[FeatureSwitchKey.VncAccess])
  ) {
    return initialSetup(sessionKey, deepLink, get(flowSequence$));
  }
  return null;
});

export const resetRemoteSetup$ = command(({ get, set }) => {
  set(resetSetupOperation$);
  if (get(setup$)) {
    set(closeSshDialog$);
    set(closeVncDialog$);
    set(closeTailscaleDialog$);
    set(closeCloudflareAccessDialog$);
  }
  set(setup$, null);
  set(flowSequence$, (value) => {
    return value + 1;
  });
});
export const leaveRemoteSetup$ = command(({ get, set }) => {
  set(resetSetupOperation$);
  set(setup$, null);
  set(flowSequence$, (value) => {
    return value + 1;
  });
  set(closeSshDialog$);
  set(closeVncDialog$);
  set(closeTailscaleDialog$);
  set(closeCloudflareAccessDialog$);
  const params = new URLSearchParams(get(searchParams$));
  params.delete("setup");
  set(updateSearchParams$, params);
});
export const enterRemoteSetup$ = command(
  ({ get, set }, protocol: "ssh" | "vnc" = "ssh") => {
    const sessionKey = get(authenticatedSessionKey$);
    if (
      !sessionKey ||
      !get(remoteControlGuidedEnabled$) ||
      (protocol === "vnc" && !get(featureSwitch$)[FeatureSwitchKey.VncAccess])
    ) {
      return;
    }
    set(leaveRemoteSetup$);
    set(setup$, initialSetup(sessionKey, protocol, get(flowSequence$)));
  },
);
export const updateRemoteSetup$ = command(
  ({ get, set }, patch: Partial<Omit<RemoteSetup, "sessionKey">>) => {
    const current = get(remoteSetup$);
    if (current) {
      set(setup$, { ...current, ...patch });
    }
  },
);
export const chooseRemoteVncProfile$ = command(
  ({ get, set }, profile: string | null) => {
    set(chooseVncProfile$, profile);
    if (
      get(remoteSetup$)?.protocol === "vnc" &&
      requiresVncProtectiveRoute(get(vncEditor$).profile)
    ) {
      set(chooseVncTransport$, "ssh");
    }
  },
);
export const beginRemoteGuide$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    if (current.protocol === "vnc") {
      set(updateRemoteSetup$, { step: "os" });
      return;
    }
    if (!get(tailscaleEnabled$)) {
      set(updateRemoteSetup$, { step: "existing" });
      return;
    }
    set(updateRemoteSetup$, { route: "tailscale", step: "install" });
    const networks = await get(tailscaleConfigs$);
    signal.throwIfAborted();
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId &&
      get(remoteSetup$)?.step === "install" &&
      !get(remoteSetup$)?.networkId &&
      networks?.length === 1
    ) {
      set(updateRemoteSetup$, { networkId: networks[0]!.id });
    }
  },
);
export const openRemoteLogin$ = command(
  async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetSetupOperation$, parentSignal);
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    if (current.formStarted) {
      set(updateRemoteSetup$, { step: "login" });
      return;
    }
    if (current.protocol === "ssh") {
      await set(openSshDialog$, "create", null, signal);
      signal.throwIfAborted();
      if (!(await get(sshDialog$))) {
        throw new Error("SSH settings are unavailable");
      }
      signal.throwIfAborted();
      set(chooseSshConnectionMode$, current.route);
      if (current.route === "tailscale") {
        set(chooseSshTailscaleConfig$, current.networkId);
      }
      if (current.route === "cloudflare_access") {
        set(chooseSshAccessConfig$, current.networkId);
      }
      set(chooseSshCredential$, "new");
      set(chooseSshAuthMethod$, "password");
    } else {
      await set(openVncDialog$, "create", null, signal);
      signal.throwIfAborted();
      if (!(await get(vncDialog$))) {
        throw new Error("VNC settings are unavailable");
      }
      signal.throwIfAborted();
    }
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, { step: "login", formStarted: true });
    }
  },
);
export const openRemoteNetwork$ = command(
  async (
    { get, set },
    kind: "tailscale" | "cloudflare_access",
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetSetupOperation$, parentSignal);
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    if (kind === "tailscale") {
      await set(openTailscaleDialog$, "create", null, signal);
      signal.throwIfAborted();
      if (
        get(remoteSetup$)?.sessionKey === current.sessionKey &&
        get(remoteSetup$)?.flowId === current.flowId
      ) {
        set(updateRemoteSetup$, { step: "oauth" });
      }
    } else {
      await set(openCloudflareAccessDialog$, "create", null, signal);
    }
    signal.throwIfAborted();
  },
);
export const saveRemoteTailscale$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const before = await get(tailscaleConfigs$);
    signal.throwIfAborted();
    await set(saveTailscale$, form, signal);
    signal.throwIfAborted();
    if (await get(tailscaleDialog$)) {
      return;
    }
    signal.throwIfAborted();
    if (
      get(remoteSetup$)?.sessionKey !== current.sessionKey ||
      get(remoteSetup$)?.flowId !== current.flowId
    ) {
      return;
    }
    set(updateRemoteSetup$, { step: "prepare", networkId: "" });
    const after = await get(tailscaleConfigs$);
    signal.throwIfAborted();
    const added = after?.filter((network) => {
      return !before?.some((previous) => {
        return previous.id === network.id;
      });
    });
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "prepare",
        networkId: added?.length === 1 ? added[0]!.id : "",
      });
    }
  },
);
export const saveRemoteCloudflare$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const before = await get(cloudflareAccessConfigs$);
    signal.throwIfAborted();
    await set(saveCloudflareAccess$, form, signal);
    signal.throwIfAborted();
    if (await get(cloudflareAccessDialog$)) {
      return;
    }
    const after = await get(cloudflareAccessConfigs$);
    signal.throwIfAborted();
    const added = after?.filter((network) => {
      return !before?.some((previous) => {
        return previous.id === network.id;
      });
    });
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        networkId: added?.length === 1 ? added[0]!.id : "",
      });
    }
  },
);
export const saveRemoteSsh$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const name = new FormData(form).get("displayName");
    await set(saveSsh$, form, signal);
    signal.throwIfAborted();
    if (
      !(await get(sshDialog$)) &&
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "saved",
        formStarted: false,
        savedName: typeof name === "string" ? name : "",
      });
    }
  },
);
export const saveRemoteVnc$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const name = new FormData(form).get("displayName");
    await set(saveVnc$, form, signal);
    signal.throwIfAborted();
    if (
      !(await get(vncDialog$)) &&
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "saved",
        formStarted: false,
        savedName: typeof name === "string" ? name : "",
      });
    }
  },
);

const networkPicker$ = state(false);
export const remoteNetworkPicker$ = computed((get) => {
  return get(remoteControlGuidedEnabled$) && get(networkPicker$);
});
export const setRemoteNetworkPicker$ = command(({ set }, open: boolean) => {
  set(networkPicker$, open);
});
export const chooseRemoteNetworkProvider$ = command(
  async (
    { get, set },
    kind: "tailscale" | "cloudflare_access",
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetSetupOperation$, parentSignal);
    if (!get(remoteControlGuidedEnabled$)) {
      return;
    }
    if (kind === "tailscale") {
      await set(openTailscaleDialog$, "create", null, signal);
    } else {
      await set(openCloudflareAccessDialog$, "create", null, signal);
    }
    signal.throwIfAborted();
    set(networkPicker$, false);
  },
);

export const openRemoteDependencySsh$ = command(
  async ({ set }, parentSignal: AbortSignal) => {
    const signal = set(resetSetupOperation$, parentSignal);
    await set(openSshDialog$, "create", null, signal);
    signal.throwIfAborted();
  },
);
