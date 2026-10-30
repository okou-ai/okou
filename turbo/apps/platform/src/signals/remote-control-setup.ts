import { openRemoteNetworkGuide$ } from "./remote-network-guide.ts";
import {
  remoteNetworkLocation$,
  openRemoteNetworkEditor$,
  closeRemoteNetworkEditor$,
} from "./remote-network-location.ts";
import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SSH_DISPLAY_NAME_MAX_LENGTH } from "@okouai/api-contracts/validators/ssh-credentials";
import type { SshConnectionMode } from "@okouai/api-contracts/contracts/ssh-connections";
import { VNC_DISPLAY_NAME_MAX_LENGTH } from "@okouai/api-contracts/validators/vnc-credentials";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import {
  searchParams$,
  updateSearchParams$,
  replaceSearchParams$,
} from "./route.ts";
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
  sshConnections$,
} from "./ssh.ts";
import {
  clearVncSaveMessage$,
  closeVncDialog$,
  openVncDialog$,
  saveVnc$,
  vncDialog$,
  chooseVncTransport$,
  chooseVncNetworkConfig$,
  chooseVncProfile$,
  vncEditor$,
  vncTransport$,
  chooseVncSshConnection$,
  vncConnections$,
} from "./vnc.ts";
import {
  closeTailscaleDialog$,
  openTailscaleDialog$,
  tailscaleConfigs$,
  tailscaleDialog$,
} from "./tailscale.ts";
import {
  closeCloudflareAccessDialog$,
  openCloudflareAccessDialog$,
  cloudflareAccessDialog$,
  cloudflareAccessConfigs$,
} from "./cloudflare-access.ts";

export type RemoteSetupStep = "entry" | "computer-network" | "login" | "saved";
export type RemoteSetupRoute = "direct" | "tailscale" | "cloudflare_access";
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
  readonly step: RemoteSetupStep;
  readonly route: RemoteSetupRoute;
  readonly address: string;
  readonly port: string;
  readonly networkId: string;
  readonly sourceNetwork: RemoteSetupNetwork | null;
  readonly fromComputer: boolean;
  readonly formStarted: boolean;
  readonly savedName: string;
  readonly savedId: string;
  readonly vncStep: RemoteVncStep;
  readonly computerScreenService: "mac" | "other" | null;
}

type RemoteSetupDraft = Omit<RemoteSetup, "step" | "vncStep">;
const setup$ = state<RemoteSetupDraft | null>(null);
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
  fromComputer = false,
): RemoteSetupDraft {
  return {
    sessionKey,
    flowId,
    protocol,
    route: sourceNetwork?.route ?? "direct",
    address: "",
    port: protocol === "ssh" ? "22" : "5900",
    networkId: sourceNetwork?.id ?? "",
    sourceNetwork,
    fromComputer,
    formStarted: false,
    savedName: "",
    savedId: "",
    computerScreenService: null,
  };
}

function setupNetworkFromLocation(
  params: URLSearchParams,
  draft: RemoteSetupDraft,
): RemoteSetupNetwork | null {
  const [route, id] = (params.get("setupNetwork") ?? "").split(":");
  if (!id || (route !== "tailscale" && route !== "cloudflare_access")) {
    return null;
  }
  return {
    id,
    route,
    name: draft.sourceNetwork?.id === id ? draft.sourceNetwork.name : "",
  };
}

function setupStepsFromLocation(
  params: URLSearchParams,
): Pick<RemoteSetup, "step" | "vncStep"> {
  const setup = params.get("setup");
  const requested = params.get("step");
  const vncStep =
    requested === "connection" || requested === "login" || requested === "trust"
      ? requested
      : "profile";
  if (setup === "computer") {
    return { step: "computer-network", vncStep };
  }
  if (requested === "saved" && params.get("savedConnection")) {
    return { step: "saved", vncStep };
  }
  if (
    (setup === "ssh" && requested === "login") ||
    (setup === "vnc" &&
      ["profile", "connection", "login", "trust"].includes(requested ?? ""))
  ) {
    return { step: "login", vncStep };
  }
  return { step: "entry", vncStep };
}

const remoteSetupProtocol$ = computed((get) => {
  const requested = get(searchParams$).get("setup");
  if (requested === "vnc") {
    return "vnc";
  }
  if (
    requested !== "add" &&
    requested !== "ssh" &&
    requested !== "computer" &&
    requested !== "computer-use"
  ) {
    return null;
  }
  const draft = get(setup$);
  return requested === "add" &&
    draft?.sessionKey === get(authenticatedSessionKey$)
    ? draft.protocol
    : "ssh";
});

export const remoteSetup$ = computed((get): RemoteSetup | null => {
  const sessionKey = get(authenticatedSessionKey$);
  const protocol = get(remoteSetupProtocol$);
  if (
    !get(remoteControlGuidedEnabled$) ||
    !sessionKey ||
    !protocol ||
    get(searchParams$).get("scope") !== "remote-control"
  ) {
    return null;
  }
  const params = get(searchParams$);
  const current = get(setup$);
  const deepLink = params.get("setup");
  if (deepLink === "computer-use") {
    return {
      ...initialSetup(sessionKey, "ssh", get(flowSequence$)),
      step: "entry",
      vncStep: "profile",
    };
  }
  const draft =
    current?.sessionKey === sessionKey && current.protocol === protocol
      ? current
      : initialSetup(sessionKey, protocol, get(flowSequence$));
  const sourceNetwork = setupNetworkFromLocation(params, draft);
  return {
    ...draft,
    sourceNetwork,
    fromComputer: params.get("fromComputer") === "1",
    route: sourceNetwork?.route ?? draft.route,
    networkId: sourceNetwork?.id ?? draft.networkId,
    savedId: params.get("savedConnection") ?? "",
    savedName:
      draft.savedId === params.get("savedConnection") ? draft.savedName : "",
    ...setupStepsFromLocation(params),
  };
});

export const remoteSetupSavedName$ = computed(async (get) => {
  const setup = get(remoteSetup$);
  if (!setup || setup.step !== "saved") {
    return null;
  }
  if (setup.savedName) {
    return setup.savedName;
  }
  const connections = await (setup.protocol === "ssh"
    ? get(sshConnections$)
    : get(vncConnections$));
  if (!connections) {
    throw new Error("Saved connections are unavailable");
  }
  return (
    connections.find((connection) => {
      return connection.id === setup.savedId;
    })?.displayName ?? null
  );
});

export function clearRemoteSetupParams(params: URLSearchParams) {
  for (const key of [
    "step",
    "setupNetwork",
    "fromComputer",
    "savedConnection",
    "vncProfile",
    "vncRoute",
    "vncNetwork",
    "vncSsh",
    "computerUseStep",
  ]) {
    params.delete(key);
  }
}

const writeRemoteSetupLocation$ = command(
  ({ get, set }, current: RemoteSetup, replace = false) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set("setup", current.protocol);
    params.set(
      "step",
      current.step === "login" && current.protocol === "vnc"
        ? current.vncStep
        : current.step,
    );
    if (current.sourceNetwork) {
      params.set(
        "setupNetwork",
        `${current.sourceNetwork.route}:${current.sourceNetwork.id}`,
      );
    }
    if (current.fromComputer) {
      params.set("fromComputer", "1");
    }
    if (current.step === "saved") {
      params.set("savedConnection", current.savedId);
    } else {
      params.delete("savedConnection");
    }
    if (current.protocol === "vnc" && current.formStarted) {
      const editor = get(vncEditor$);
      params.set("vncProfile", editor.profile);
      params.set("vncRoute", editor.transport);
      if (editor.networkConfigId) {
        params.set("vncNetwork", editor.networkConfigId);
      } else {
        params.delete("vncNetwork");
      }
      if (editor.sshConnectionId) {
        params.set("vncSsh", editor.sshConnectionId);
      } else {
        params.delete("vncSsh");
      }
    }
    if (params.toString() !== get(searchParams$).toString()) {
      set(replace ? replaceSearchParams$ : updateSearchParams$, params);
    }
  },
);
export const remoteComputerNetworks$ = computed(
  async (get): Promise<readonly RemoteSetupNetwork[]> => {
    const configs = await get(tailscaleConfigs$);
    if (!configs) {
      throw new Error("Saved Tailscale networks are unavailable");
    }
    return configs.map(({ id, name }) => {
      return { id, name, route: "tailscale" };
    });
  },
);
/** Only saved networks are available here; provisioning belongs to private networks. */
export const remoteSetupNetworks$ = computed(
  async (get): Promise<readonly RemoteSetupNetwork[]> => {
    const [tailscale, access] = await Promise.all([
      get(tailscaleConfigs$),
      get(cloudflareAccessConfigs$),
    ]);
    if (!tailscale || !access) {
      throw new Error("Saved networks are unavailable");
    }
    return [
      ...tailscale.map(({ id, name }): RemoteSetupNetwork => {
        return {
          id,
          name,
          route: "tailscale",
        };
      }),
      ...access.map(({ id, name }): RemoteSetupNetwork => {
        return {
          id,
          name,
          route: "cloudflare_access",
        };
      }),
    ];
  },
);
export const remoteVncConnectionOptionsAvailable$ = computed(async (get) => {
  const transport = get(vncTransport$);
  if (transport === "direct") {
    return true;
  }
  const options = await (transport === "ssh"
    ? get(sshConnections$)
    : transport === "tailscale"
      ? get(tailscaleConfigs$)
      : get(cloudflareAccessConfigs$));
  return options !== null && options.length > 0;
});

export const resetRemoteSetup$ = command(({ get, set }) => {
  set(resetSetupOperation$);
  if (get(setup$)) {
    set(closeSshDialog$);
    set(closeVncDialog$);
    set(closeTailscaleDialog$, true);
    set(closeCloudflareAccessDialog$, true);
  }
  set(setup$, null);
  set(flowSequence$, (value) => {
    return value + 1;
  });
});
export const leaveRemoteSetup$ = command(({ get, set }) => {
  const current = get(remoteSetup$);
  const sourceNetwork = current?.fromComputer ? null : current?.sourceNetwork;
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
  clearRemoteSetupParams(params);
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
    fromComputer?: boolean,
  ) => {
    const sessionKey = get(authenticatedSessionKey$);
    if (!sessionKey || !get(remoteControlGuidedEnabled$)) {
      return;
    }
    set(resetRemoteSetup$);
    const params = new URLSearchParams(get(searchParams$));
    clearRemoteSetupParams(params);
    params.set("setup", "add");
    if (sourceNetwork) {
      params.set("setupNetwork", `${sourceNetwork.route}:${sourceNetwork.id}`);
    }
    if (fromComputer) {
      params.set("fromComputer", "1");
    }
    params.delete("remoteResource");
    params.delete("networkConnections");
    params.set("scope", "remote-control");
    set(updateSearchParams$, params);
    set(
      setup$,
      initialSetup(
        sessionKey,
        protocol,
        get(flowSequence$),
        sourceNetwork,
        fromComputer,
      ),
    );
  },
);
export const chooseRemoteProtocol$ = command(
  ({ get, set }, protocol: "ssh" | "vnc") => {
    const current = get(remoteSetup$);
    if (current && current.protocol !== protocol) {
      set(
        enterRemoteSetup$,
        protocol,
        current.sourceNetwork,
        current.fromComputer,
      );
    }
  },
);
export const startComputerSetup$ = command(({ get, set }) => {
  if (!get(remoteControlGuidedEnabled$) || !get(authenticatedSessionKey$)) {
    return;
  }
  set(resetRemoteSetup$);
  const params = new URLSearchParams(get(searchParams$));
  clearRemoteSetupParams(params);
  params.set("scope", "remote-control");
  params.set("setup", "computer");
  params.delete("remoteResource");
  params.delete("networkConnections");
  set(updateSearchParams$, params);
});
export const closeRemoteComputerUseSetup$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set("setup", "add");
  params.delete("computerUseStep");
  set(updateSearchParams$, params);
});
export const updateRemoteSetup$ = command(
  ({ get, set }, patch: Partial<Omit<RemoteSetup, "sessionKey">>) => {
    const current = get(remoteSetup$);
    if (current) {
      if (
        current.protocol === "vnc" &&
        patch.vncStep !== undefined &&
        patch.vncStep !== current.vncStep
      ) {
        set(clearVncSaveMessage$);
      }
      const next = { ...current, ...patch };
      const { step, vncStep, ...draft } = next;
      set(setup$, draft);
      if (patch.step !== undefined || patch.vncStep !== undefined) {
        set(writeRemoteSetupLocation$, { ...draft, step, vncStep });
      }
    }
  },
);
export const chooseRemoteSshConnection$ = command(
  ({ set }, mode: SshConnectionMode, networkId: string) => {
    const tailscale = mode === "tailscale" || mode === "tailscale_ssh";
    set(chooseSshConnectionMode$, mode);
    if (tailscale) {
      set(chooseSshTailscaleConfig$, networkId);
    } else if (mode === "cloudflare_access") {
      set(chooseSshAccessConfig$, networkId);
    }
    set(updateRemoteSetup$, {
      route: mode === "tailscale_ssh" ? "tailscale" : mode,
      networkId: mode === "direct" ? "" : networkId,
    });
  },
);
export const chooseComputerScreenService$ = command(
  ({ get, set }, service: "mac" | "other") => {
    const current = get(remoteSetup$);
    if (!current?.fromComputer || current.protocol !== "vnc") {
      return;
    }
    set(chooseVncProfile$, service === "mac" ? "apple_dh" : "x509_vnc");
    set(updateRemoteSetup$, { computerScreenService: service });
  },
);
export const goBackRemoteSetup$ = command(({ get, set }) => {
  const current = get(remoteSetup$);
  if (!current) {
    return;
  }
  if (current.step === "entry" && current.fromComputer) {
    set(startComputerSetup$);
    set(updateRemoteSetup$, {
      route: current.route,
      networkId: current.networkId,
    });
    return;
  }
  if (current.step === "entry" || current.step === "saved") {
    set(leaveRemoteSetup$);
    return;
  }
  if (current.step === "computer-network") {
    set(enterRemoteSetup$);
    return;
  }
  if (current.protocol === "vnc" && current.vncStep !== "profile") {
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
  // Returning to the entry starts a fresh attempt, without hidden login drafts.
  const { route, networkId } = current;
  set(
    enterRemoteSetup$,
    current.protocol,
    current.sourceNetwork,
    current.fromComputer,
  );
  set(updateRemoteSetup$, {
    route,
    networkId,
    step: "entry",
  });
});
const restoreRemoteVncLocation$ = command(({ get, set }) => {
  const params = get(searchParams$);
  set(chooseVncProfile$, params.get("vncProfile"));
  const transport = params.get("vncRoute");
  if (
    transport === "direct" ||
    transport === "ssh" ||
    transport === "tailscale" ||
    transport === "cloudflare_access"
  ) {
    set(chooseVncTransport$, transport);
  }
  const networkId = params.get("vncNetwork");
  if (networkId) {
    set(chooseVncNetworkConfig$, "rfb", networkId);
  }
  const sshId = params.get("vncSsh");
  if (sshId) {
    set(chooseVncSshConnection$, sshId);
  }
});

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
      if (current.route !== "direct") {
        set(chooseVncTransport$, current.route);
        set(chooseVncNetworkConfig$, "rfb", current.networkId);
      }
      set(restoreRemoteVncLocation$);
    }
    if (
      get(remoteSetup$)?.sessionKey === current.sessionKey &&
      get(remoteSetup$)?.flowId === current.flowId
    ) {
      const { step: _step, vncStep, ...draft } = current;
      set(setup$, { ...draft, formStarted: true });
      set(
        writeRemoteSetupLocation$,
        { ...current, step: "login", vncStep, formStarted: true },
        current.step === "login",
      );
    }
  },
);
function connectionName(form: HTMLFormElement, defaultName?: string) {
  const field = form.elements.namedItem("displayName");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("Missing connection name field");
  }
  // An uncertain save locks controls; FormData omits those disabled inputs.
  if (defaultName !== undefined) {
    const label = form.elements.namedItem("connectionLabel");
    if (!(label instanceof HTMLInputElement)) {
      throw new Error("Missing optional connection name field");
    }
    // Keep the editable label empty so a changed address gets a fresh default.
    field.value = label.value.trim() || defaultName;
  }
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
    const name = connectionName(
      form,
      current.address.trim().slice(0, SSH_DISPLAY_NAME_MAX_LENGTH),
    );
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
    const name = connectionName(
      form,
      current.fromComputer
        ? get(vncEditor$)
            .destinationHost.trim()
            .slice(0, VNC_DISPLAY_NAME_MAX_LENGTH)
        : undefined,
    );
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

export const remoteNetworkPicker$ = computed((get) => {
  return get(remoteNetworkLocation$)?.provider === "add";
});
export const setRemoteNetworkPicker$ = command(({ set }, open: boolean) => {
  if (open) {
    set(openRemoteNetworkEditor$, "add");
  } else {
    set(closeRemoteNetworkEditor$);
  }
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
    signal.throwIfAborted();
    set(
      openRemoteNetworkGuide$,
      kind === "tailscale" ? "tailscale" : "cloudflare",
      kind === "tailscale" ? tags : "",
      true,
    );
  },
);
export const addComputerNetwork$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(remoteSetup$)?.step !== "computer-network") {
      return;
    }
    await set(chooseRemoteNetworkProvider$, "tailscale", "tag:okou", signal);
    signal.throwIfAborted();
    const dialog = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (dialog?.kind !== "create") {
      throw new Error("Tailscale settings are unavailable");
    }
    const params = new URLSearchParams(get(searchParams$));
    params.set("scope", "private-network");
    params.set("setup", "computer");
    params.set("network", "tailscale");
    set(updateSearchParams$, params);
  },
);
