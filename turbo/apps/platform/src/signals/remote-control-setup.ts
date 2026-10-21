import {
  openRemoteNetworkGuide$,
  closeRemoteNetworkGuide$,
} from "./remote-network-guide.ts";
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
  sshConnectionModeEditor$,
} from "./ssh.ts";
import {
  closeVncDialog$,
  openVncDialog$,
  saveVnc$,
  vncDialog$,
  vncEnabled$,
  chooseVncTransport$,
  chooseVncNetworkConfig$,
} from "./vnc.ts";
import {
  closeTailscaleDialog$,
  openTailscaleDialog$,
  saveTailscale$,
  tailscaleConfigs$,
  tailscaleDialog$,
  tailscaleEnabled$,
  tailscaleFieldsFromForm,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  openCloudflareAccessDialog$,
  saveCloudflareAccess$,
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
  | "service"
  | "cf-address"
  | "cf-access"
  | "cf-credentials"
  | "login"
  | "saved";
export type RemoteSetupRoute = "direct" | "tailscale" | "cloudflare_access";
export type RemoteSetupOs = "mac" | "windows" | "linux";
export type RemoteVncStep = "profile" | "connection" | "login" | "trust";
export interface RemoteSetupNetwork {
  readonly id: string;
  readonly name: string;
  readonly route: "tailscale" | "cloudflare_access";
}
export interface RemoteSetup {
  readonly sessionKey: string;
  readonly flowId: number;
  readonly protocol: "ssh" | "vnc";
  readonly entryMode: "guided" | "existing";
  readonly step: RemoteSetupStep;
  readonly route: RemoteSetupRoute;
  readonly os: RemoteSetupOs;
  readonly address: string;
  readonly port: string;
  readonly networkId: string;
  readonly sourceNetwork: RemoteSetupNetwork | null;
  readonly tailscaleTags: string;
  readonly formStarted: boolean;
  readonly savedName: string;
  readonly savedId: string;
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
  sourceNetwork: RemoteSetupNetwork | null = null,
): RemoteSetup {
  return {
    sessionKey,
    flowId,
    protocol,
    entryMode: "guided",
    step: "entry",
    route: sourceNetwork?.route ?? "direct",
    os: "mac",
    address: "",
    port: protocol === "ssh" ? "22" : "5900",
    networkId: sourceNetwork?.id ?? "",
    sourceNetwork,
    tailscaleTags: "tag:okou",
    formStarted: false,
    savedName: "",
    savedId: "",
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
  if (deepLink === "ssh" || (deepLink === "vnc" && get(vncEnabled$))) {
    return initialSetup(sessionKey, deepLink, get(flowSequence$));
  }
  return null;
});
export const remoteSetupTailscaleTags$ = computed((get) => {
  return (
    get(remoteSetup$)
      ?.tailscaleTags.split(/[,\s]+/u)
      .filter(Boolean) ?? []
  );
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
  const sourceNetwork = get(remoteSetup$)?.sourceNetwork;
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
  if (sourceNetwork) {
    params.set("scope", "private-network");
    params.set(
      "remoteResource",
      `${sourceNetwork.route === "tailscale" ? "tailscale" : "cloudflare"}:${sourceNetwork.id}`,
    );
  }
  set(updateSearchParams$, params);
});
export const enterRemoteSetup$ = command(
  (
    { get, set },
    protocol: "ssh" | "vnc" = "ssh",
    sourceNetwork: RemoteSetupNetwork | null = null,
  ) => {
    const sessionKey = get(authenticatedSessionKey$);
    const selectedProtocol =
      sourceNetwork?.route === "tailscale" && !get(tailscaleEnabled$)
        ? "vnc"
        : protocol;
    if (
      !sessionKey ||
      !get(remoteControlGuidedEnabled$) ||
      (selectedProtocol === "vnc" && !get(vncEnabled$))
    ) {
      return;
    }
    set(resetRemoteSetup$);
    const params = new URLSearchParams(get(searchParams$));
    params.delete("setup");
    params.delete("remoteResource");
    params.delete("networkConnections");
    params.set("scope", "remote-control");
    set(updateSearchParams$, params);
    set(
      setup$,
      initialSetup(
        sessionKey,
        selectedProtocol,
        get(flowSequence$),
        sourceNetwork,
      ),
    );
  },
);
export const chooseRemoteProtocol$ = command(
  ({ get, set }, protocol: "ssh" | "vnc") => {
    const current = get(remoteSetup$);
    if (current && current.protocol !== protocol) {
      set(enterRemoteSetup$, protocol, current.sourceNetwork);
    }
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
export const startNewRemoteNetwork$ = command(({ get, set }) => {
  const current = get(remoteSetup$);
  if (current?.step !== "install" || current.route !== "tailscale") {
    return;
  }
  set(closeTailscaleDialog$);
  set(updateRemoteSetup$, {
    networkId: "new",
    tailscaleTags: "tag:okou",
    step: "address",
  });
});
const PREVIOUS_STEP: Readonly<
  Partial<Record<RemoteSetupStep, RemoteSetupStep>>
> = {
  existing: "entry",
  install: "entry",
  address: "install",
  tag: "address",
  rule: "tag",
  oauth: "rule",
  prepare: "address",
  service: "entry",
  "cf-address": "existing",
  "cf-access": "cf-address",
  "cf-credentials": "cf-access",
};
function previousRemoteSetupStep(current: RemoteSetup): RemoteSetupStep {
  if (current.step !== "login") {
    if (
      current.sourceNetwork &&
      (current.step === "address" || current.step === "cf-address")
    ) {
      return "entry";
    }
    return PREVIOUS_STEP[current.step] ?? "entry";
  }
  if (current.protocol === "vnc") {
    return current.entryMode === "existing" ? "entry" : "service";
  }
  if (current.sourceNetwork && current.entryMode === "existing") {
    return "entry";
  }
  if (current.route === "cloudflare_access") {
    return current.sourceNetwork ? "cf-address" : "cf-access";
  }
  return current.route === "direct" || current.entryMode === "existing"
    ? "existing"
    : "prepare";
}
export const goBackRemoteSetup$ = command(({ get, set }) => {
  const current = get(remoteSetup$);
  if (!current) {
    return;
  }
  if (current.step === "entry" || current.step === "saved") {
    set(leaveRemoteSetup$);
    return;
  }
  if (
    current.step === "login" &&
    current.protocol === "vnc" &&
    current.vncStep !== "profile"
  ) {
    set(updateRemoteSetup$, {
      vncStep:
        current.vncStep === "trust"
          ? "login"
          : current.vncStep === "login"
            ? "connection"
            : "profile",
    });
    return;
  }
  if (current.step === "login" && current.protocol === "ssh") {
    const editor = get(sshConnectionModeEditor$);
    set(updateRemoteSetup$, {
      networkId:
        current.route === "cloudflare_access"
          ? (editor.configId ?? "")
          : current.route === "tailscale"
            ? (editor.tailscaleConfigId ?? "")
            : current.networkId,
    });
  }
  set(updateRemoteSetup$, { step: previousRemoteSetupStep(current) });
});
export const beginRemoteGuide$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    set(updateRemoteSetup$, { entryMode: "guided" });
    if (current.protocol === "vnc") {
      set(updateRemoteSetup$, { step: "service" });
      return;
    }
    if (current.sourceNetwork) {
      set(updateRemoteSetup$, {
        step: current.route === "tailscale" ? "address" : "cf-address",
      });
      return;
    }
    if (!get(tailscaleEnabled$)) {
      return;
    }
    set(updateRemoteSetup$, {
      route: "tailscale",
      step: "install",
      ...(current.route !== "tailscale"
        ? { address: "", networkId: "", formStarted: false }
        : {}),
    });
    const networks = await get(tailscaleConfigs$);
    signal.throwIfAborted();
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId &&
      get(remoteSetup$)?.step === "install" &&
      !get(remoteSetup$)?.networkId &&
      networks?.length === 1
    ) {
      set(updateRemoteSetup$, {
        networkId: networks[0]!.id,
        tailscaleTags: networks[0]!.tags.join(", "),
      });
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
      if (current.protocol === "ssh" && current.route === "cloudflare_access") {
        set(chooseSshAccessConfig$, current.networkId);
      } else if (current.protocol === "ssh" && current.route === "tailscale") {
        set(chooseSshTailscaleConfig$, current.networkId);
      }
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
      if (current.route === "tailscale" && current.networkId) {
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
      if (current.sourceNetwork) {
        set(chooseVncTransport$, current.sourceNetwork.route);
        set(chooseVncNetworkConfig$, "rfb", current.networkId);
      }
    }
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, { step: "login", formStarted: true });
    }
  },
);
export const openExistingRemoteSetup$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    set(updateRemoteSetup$, { entryMode: "existing" });
    if (current.protocol === "vnc" || current.sourceNetwork) {
      await set(openRemoteLogin$, signal);
      signal.throwIfAborted();
    } else {
      set(updateRemoteSetup$, { step: "existing" });
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
      const dialog = await get(tailscaleDialog$);
      signal.throwIfAborted();
      if (!dialog) {
        await set(openTailscaleDialog$, "create", null, signal);
      }
      signal.throwIfAborted();
      if (
        get(remoteSetup$)?.sessionKey === current.sessionKey &&
        get(remoteSetup$)?.flowId === current.flowId
      ) {
        set(updateRemoteSetup$, { step: "oauth" });
      }
    } else {
      const dialog = await get(cloudflareAccessDialog$);
      signal.throwIfAborted();
      if (!dialog) {
        await set(openCloudflareAccessDialog$, "create", null, signal);
      }
      signal.throwIfAborted();
      if (
        get(remoteSetup$)?.sessionKey === current.sessionKey &&
        get(remoteSetup$)?.flowId === current.flowId
      ) {
        set(updateRemoteSetup$, { step: "cf-credentials" });
      }
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
    const tags = tailscaleFieldsFromForm(form).tags;
    const savedId = await set(saveTailscale$, form, signal);
    signal.throwIfAborted();
    if (
      !savedId ||
      get(remoteSetup$)?.sessionKey !== current.sessionKey ||
      get(remoteSetup$)?.flowId !== current.flowId
    ) {
      return;
    }
    set(updateRemoteSetup$, {
      step: "prepare",
      networkId: savedId,
      tailscaleTags: tags.join(", "),
    });
    return savedId;
  },
);
export const saveRemoteCloudflare$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const savedId = await set(saveCloudflareAccess$, form, signal);
    signal.throwIfAborted();
    if (
      savedId &&
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "cf-access",
        networkId: savedId,
      });
      await set(openRemoteLogin$, signal);
      signal.throwIfAborted();
    }
    return savedId;
  },
);
function connectionName(form: HTMLFormElement) {
  const field = form.elements.namedItem("displayName");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("Missing connection name field");
  }
  // An uncertain save locks controls; FormData omits those disabled inputs.
  return field.value.trim();
}

function nameRemoteCredential(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem("credentialName");
  if (field instanceof HTMLInputElement && field.type === "hidden") {
    field.value = name;
  }
}

export const saveRemoteSsh$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const name = connectionName(form);
    nameRemoteCredential(form, name);
    const savedId = await set(saveSsh$, form, signal);
    signal.throwIfAborted();
    if (
      !(await get(sshDialog$)) &&
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "saved",
        formStarted: false,
        savedName: name,
        savedId: savedId ?? "",
      });
    }
    return savedId;
  },
);
export const saveRemoteVnc$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const current = get(remoteSetup$);
    if (!current) {
      return;
    }
    const name = connectionName(form);
    nameRemoteCredential(form, name);
    const savedId = await set(saveVnc$, form, signal);
    signal.throwIfAborted();
    if (
      !(await get(vncDialog$)) &&
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      set(updateRemoteSetup$, {
        step: "saved",
        formStarted: false,
        savedName: name,
        savedId: savedId ?? "",
      });
    }
    return savedId;
  },
);

const networkPicker$ = state(false);
const networkProvider$ = state<"tailscale" | "cloudflare_access" | null>(null);
export const selectedRemoteNetworkProvider$ = computed((get) => {
  return get(remoteControlGuidedEnabled$) ? get(networkProvider$) : null;
});
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
    tags: string,
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetSetupOperation$, parentSignal);
    if (!get(remoteControlGuidedEnabled$)) {
      return;
    }
    if (kind === "tailscale") {
      const existing = await get(tailscaleDialog$);
      signal.throwIfAborted();
      if (existing?.kind !== "create") {
        await set(openTailscaleDialog$, "create", null, signal);
      }
    } else {
      const existing = await get(cloudflareAccessDialog$);
      signal.throwIfAborted();
      if (existing?.kind !== "create") {
        await set(openCloudflareAccessDialog$, "create", null, signal);
      }
    }
    set(networkProvider$, kind);
    signal.throwIfAborted();
    set(networkPicker$, false);
    set(
      openRemoteNetworkGuide$,
      kind === "tailscale" ? "tailscale" : "cloudflare",
      kind === "tailscale" ? tags : "",
      true,
    );
  },
);
export const returnToRemoteNetworkProvider$ = command(({ set }) => {
  set(closeRemoteNetworkGuide$, true);
  set(networkPicker$, true);
});

export const openRemoteDependencySsh$ = command(
  async ({ set }, parentSignal: AbortSignal) => {
    const signal = set(resetSetupOperation$, parentSignal);
    await set(openSshDialog$, "create", null, signal);
    signal.throwIfAborted();
  },
);
