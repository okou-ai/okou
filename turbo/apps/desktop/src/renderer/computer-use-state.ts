import { command, computed, state } from "ccstate";
import type {
  DesktopAuthApi,
  DesktopAuthState,
  DesktopComputerUseApi,
  DesktopDeveloperToolsApi,
  DesktopDeveloperToolsState,
} from "../desktop-bridge";
import type {
  ComputerUseAutomationPermissionTarget,
  DesktopComputerUseState,
} from "../computer-use-types";

const DEFAULT_DEVELOPER_TOOLS_STATE: DesktopDeveloperToolsState = {
  available: false,
  enabled: false,
};
const reloadComputerUseState$ = state(0);
const reloadDesktopAuthState$ = state(0);
const reloadDeveloperToolsState$ = state(0);

function desktopComputerUseApi(): DesktopComputerUseApi {
  const api = window.okouDesktopComputerUse;
  if (!api) {
    throw new Error("Desktop Computer Use bridge is unavailable");
  }
  return api;
}

function desktopAuthApi(): DesktopAuthApi {
  const api = window.vm0DesktopAuth;
  if (!api) {
    throw new Error("Desktop auth bridge is unavailable");
  }
  return api;
}

function desktopDeveloperToolsApi(): DesktopDeveloperToolsApi | null {
  return window.okouDesktopDeveloperTools ?? null;
}

export function hasDesktopComputerUseBridge(): boolean {
  return Boolean(window.okouDesktopComputerUse);
}

export function hasDesktopAuthBridge(): boolean {
  return Boolean(window.vm0DesktopAuth);
}

export function hasDesktopDeveloperToolsBridge(): boolean {
  return Boolean(window.okouDesktopDeveloperTools);
}

export const computerUseData$ = computed(
  (get): Promise<DesktopComputerUseState> => {
    get(reloadComputerUseState$);
    return desktopComputerUseApi().getState();
  },
);

export const desktopAuthData$ = computed((get): Promise<DesktopAuthState> => {
  get(reloadDesktopAuthState$);
  return desktopAuthApi().getState();
});

export const developerToolsData$ = computed(
  (get): Promise<DesktopDeveloperToolsState> => {
    get(reloadDeveloperToolsState$);
    return (
      desktopDeveloperToolsApi()?.getState() ??
      Promise.resolve(DEFAULT_DEVELOPER_TOOLS_STATE)
    );
  },
);

const reloadComputerUse$ = command(({ set }) => {
  set(reloadComputerUseState$, (count) => {
    return count + 1;
  });
});

export const refreshComputerUse$ = command(async ({ set }) => {
  await desktopComputerUseApi().refreshPermissions();
  set(reloadComputerUse$);
});

const refreshDesktopAuth$ = command(({ set }) => {
  set(reloadDesktopAuthState$, (count) => {
    return count + 1;
  });
});

const reloadDeveloperTools$ = command(({ set }) => {
  set(reloadDeveloperToolsState$, (count) => {
    return count + 1;
  });
});

export const setupComputerUseBridge$ = command(
  ({ set }, signal: AbortSignal) => {
    const unsubscribeComputerUse = desktopComputerUseApi().subscribe(() => {
      set(reloadComputerUse$);
    });
    const unsubscribeAuth = window.vm0DesktopAuth?.subscribe(() => {
      set(refreshDesktopAuth$);
      set(reloadComputerUse$);
    });
    const unsubscribeDeveloperTools = desktopDeveloperToolsApi()?.subscribe(
      () => {
        set(reloadDeveloperTools$);
      },
    );

    signal.addEventListener(
      "abort",
      () => {
        unsubscribeComputerUse();
        unsubscribeAuth?.();
        unsubscribeDeveloperTools?.();
      },
      { once: true },
    );
    set(refreshDesktopAuth$);
    set(refreshComputerUse$);
    set(reloadDeveloperTools$);
  },
);

export const startComputerUse$ = command(async ({ set }) => {
  try {
    await desktopComputerUseApi().start({ userInitiated: true });
  } finally {
    set(reloadComputerUse$);
  }
});

export const stopComputerUse$ = command(async ({ set }) => {
  try {
    await desktopComputerUseApi().stop();
  } finally {
    set(reloadComputerUse$);
  }
});

export const requestAccessibilityPermission$ = command(async ({ set }) => {
  await desktopComputerUseApi().requestAccessibilityPermission();
  set(reloadComputerUse$);
});

export const requestScreenRecordingPermission$ = command(async ({ set }) => {
  await desktopComputerUseApi().requestScreenRecordingPermission();
  set(reloadComputerUse$);
});

export const probeAutomationPermission$ = command(
  async ({ set }, target: ComputerUseAutomationPermissionTarget) => {
    await desktopComputerUseApi().probeAutomationPermission(target);
    set(reloadComputerUse$);
  },
);

export const setKeepAwakeEnabled$ = command(
  async ({ set }, enabled: boolean) => {
    await desktopComputerUseApi().setKeepAwakeEnabled(enabled);
    set(reloadComputerUse$);
  },
);

export const setFilesystemPluginEnabled$ = command(
  async ({ set }, enabled: boolean) => {
    await desktopComputerUseApi().setFilesystemPluginEnabled(enabled);
    set(reloadComputerUse$);
  },
);

export const addFilesystemPluginAllowedDirectory$ = command(async ({ set }) => {
  await desktopComputerUseApi().addFilesystemPluginAllowedDirectory();
  set(reloadComputerUse$);
});

export const importMcpPluginServers$ = command(
  async ({ set }, json: string) => {
    await desktopComputerUseApi().importMcpPluginServers(json);
    set(reloadComputerUse$);
  },
);

export const setMcpPluginServerEnabled$ = command(
  async (
    { set },
    { server, enabled }: { readonly server: string; readonly enabled: boolean },
  ) => {
    await desktopComputerUseApi().setMcpPluginServerEnabled(server, enabled);
    set(reloadComputerUse$);
  },
);

export const removeMcpPluginServer$ = command(
  async ({ set }, server: string) => {
    await desktopComputerUseApi().removeMcpPluginServer(server);
    set(reloadComputerUse$);
  },
);

export const removeFilesystemPluginAllowedDirectory$ = command(
  async ({ set }, directory: string) => {
    await desktopComputerUseApi().removeFilesystemPluginAllowedDirectory(
      directory,
    );
    set(reloadComputerUse$);
  },
);

export const openAccessibilitySettings$ = command(async () => {
  await desktopComputerUseApi().openAccessibilitySettings();
});

export const openScreenRecordingSettings$ = command(async () => {
  await desktopComputerUseApi().openScreenRecordingSettings();
});

export const openAutomationSettings$ = command(async () => {
  await desktopComputerUseApi().openAutomationSettings();
});

export const openDesktopSignIn$ = command(async () => {
  await desktopAuthApi().openSignIn();
});

export const openDesktopOrgSelection$ = command(async ({ set }) => {
  await desktopAuthApi().openOrgSelection();
  set(refreshDesktopAuth$);
  set(reloadComputerUse$);
});

export const signOutDesktop$ = command(async ({ set }) => {
  await desktopAuthApi().signOut();
  set(refreshDesktopAuth$);
  set(reloadComputerUse$);
});
